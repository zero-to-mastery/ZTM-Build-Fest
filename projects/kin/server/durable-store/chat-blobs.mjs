// DurableStore chat content blobs (#110): encrypted message content by
// content hash, tombstones for retired blobs, claims for blobs retired
// before their upload arrived, and running per-household counts.
//
// Every decision is made here, inside one transaction, so a check and the
// write it allows can't be split. Callers have authorized the device and
// (for uploads) checked the bytes against the reference.
import {
  MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOBS,
  MAX_MEMBER_CHAT_CLAIMS,
  MAX_HOUSEHOLD_CHAT_TOMBSTONES,
} from "./shared.mjs";

/** The household bounds; tests lower them through `store.chatBlobLimits`. */
function limits(store) {
  return {
    blobs: MAX_HOUSEHOLD_CHAT_BLOBS, bytes: MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
    tombstones: MAX_HOUSEHOLD_CHAT_TOMBSTONES, claims: MAX_MEMBER_CHAT_CLAIMS,
    ...store.chatBlobLimits,
  };
}

const META = "blob_ref, retired, size_bytes, uploader_member_id, uploader_device_id, created_at, retired_at";
const meta = (row) => row ? {
  ref: row.blob_ref,
  retired: row.retired === 1,
  size: row.size_bytes,
  uploaderMemberId: row.uploader_member_id,
  uploaderDeviceId: row.uploader_device_id,
  createdAt: row.created_at,
  retiredAt: row.retired_at,
} : null;

export const chatBlobMethods = {
  /** A blob's row without its bytes, or null. */
  chatBlobMeta(householdId, ref) {
    this.assertAvailable();
    return meta(this.db.prepare(`SELECT ${META} FROM chat_blobs WHERE household_id = ? AND blob_ref = ?`).get(householdId, ref));
  },

  /** A live blob's bytes, or null. */
  chatBlobBytes(householdId, ref) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT ciphertext FROM chat_blobs WHERE household_id = ? AND blob_ref = ? AND retired = 0").get(householdId, ref);
    return row ? Buffer.from(row.ciphertext) : null;
  },

  chatBlobUsage(householdId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT live_blobs, live_bytes, tombstones, claims FROM chat_blob_usage WHERE household_id = ?").get(householdId);
    return row
      ? { liveBlobs: row.live_blobs, liveBytes: row.live_bytes, tombstones: row.tombstones, claims: row.claims }
      : { liveBlobs: 0, liveBytes: 0, tombstones: 0, claims: 0 };
  },

  /**
   * Stores a new blob. Returns "accepted", "exists" (already stored), or
   * "deleted": retired already, or retired before it arrived by its own
   * member or an admin. Claims by anyone else are dropped: they can't stop
   * another member's upload. "full" when the household's quota is reached.
   */
  putChatBlob(householdId, ref, ciphertext, { memberId, deviceId, now }) {
    return this.transaction(() => {
      const existing = this.chatBlobMeta(householdId, ref);
      if (existing) return existing.retired ? "deleted" : "exists";
      const claims = this.db.prepare("SELECT member_id, by_admin FROM chat_blob_claims WHERE household_id = ? AND blob_ref = ?").all(householdId, ref);
      if (claims.some((claim) => claim.member_id === memberId || claim.by_admin === 1)) return "deleted";
      const usage = this.chatBlobUsage(householdId);
      const bound = limits(this);
      if (usage.liveBlobs >= bound.blobs || usage.liveBytes + ciphertext.length > bound.bytes) return "full";
      if (claims.length) this.db.prepare("DELETE FROM chat_blob_claims WHERE household_id = ? AND blob_ref = ?").run(householdId, ref);
      this.db.prepare(`INSERT INTO chat_blobs
        (household_id, blob_ref, retired, size_bytes, uploader_member_id, uploader_device_id, created_at, retired_at, ciphertext)
        VALUES (?, ?, 0, ?, ?, ?, ?, NULL, ?)`)
        .run(householdId, ref, ciphertext.length, memberId, deviceId, now, ciphertext);
      this.adjustChatBlobUsage(householdId, { liveBlobs: 1, liveBytes: ciphertext.length, claims: -claims.length });
      return "accepted";
    });
  },

  /**
   * Retires blobs for `memberId`, all or none: "forbidden" (and nothing
   * changes) if a live blob was uploaded by someone else and the member
   * isn't an admin. A live blob loses its bytes and becomes a tombstone; an
   * unknown one gets a claim, so its upload, if it comes later from this
   * member (or this member is an admin), is refused. Freed pages are
   * zeroed and, outside an enclosing transaction, the WAL is checkpointed,
   * so the bytes don't linger in the database files (backups keep them).
   * Returns { retired, claimed, othersRetired }.
   */
  retireChatBlobs(householdId, refs, { memberId, admin, now, within = () => {} }) {
    this.assertAvailable();
    const secureDelete = this.db.prepare("PRAGMA secure_delete").get().secure_delete;
    this.db.exec("PRAGMA secure_delete = ON");
    try {
      const result = this.transaction(() => {
        const rows = refs.map((ref) => [ref, this.chatBlobMeta(householdId, ref)]);
        if (!admin && rows.some(([, row]) => row && !row.retired && row.uploaderMemberId !== memberId)) return "forbidden";
        let retired = 0, claimed = 0, othersRetired = 0;
        const retire = this.db.prepare("UPDATE chat_blobs SET retired = 1, retired_at = ?, ciphertext = NULL WHERE household_id = ? AND blob_ref = ? AND retired = 0");
        const claim = this.db.prepare(`INSERT INTO chat_blob_claims (household_id, blob_ref, member_id, by_admin, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET by_admin = MAX(by_admin, excluded.by_admin)`);
        const claimExists = this.db.prepare("SELECT 1 FROM chat_blob_claims WHERE household_id = ? AND blob_ref = ? AND member_id = ?");
        let freedBytes = 0;
        for (const [ref, row] of rows) {
          if (row?.retired) continue;
          if (row) {
            retire.run(now, householdId, ref);
            retired += 1;
            freedBytes += row.size;
            if (row.uploaderMemberId !== memberId) othersRetired += 1;
          } else {
            if (!claimExists.get(householdId, ref, memberId)) claimed += 1;
            claim.run(householdId, ref, memberId, admin ? 1 : 0, now);
          }
        }
        this.adjustChatBlobUsage(householdId, { liveBlobs: -retired, liveBytes: -freedBytes, tombstones: retired, claims: claimed });
        this.pruneChatBlobTombstones(householdId, memberId);
        const result = { retired, claimed, othersRetired };
        // The caller's audit commits with the retire, or neither does.
        within(result);
        return result;
      });
      if (result !== "forbidden" && result.retired && !this.db.isTransaction)
        this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return result;
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${secureDelete ? "ON" : "OFF"}`);
    }
  },

  /** Keeps tombstones within their household bound and `memberId`'s claims
   * within the per-member bound, oldest first. */
  pruneChatBlobTombstones(householdId, memberId) {
    const usage = this.chatBlobUsage(householdId);
    const bound = limits(this);
    const tombstones = usage.tombstones - bound.tombstones;
    if (tombstones > 0) {
      this.db.prepare(`DELETE FROM chat_blobs WHERE rowid IN (SELECT rowid FROM chat_blobs
        WHERE household_id = ? AND retired = 1 ORDER BY retired_at, blob_ref LIMIT ?)`).run(householdId, tombstones);
    }
    const own = this.db.prepare("SELECT COUNT(*) AS count FROM chat_blob_claims WHERE household_id = ? AND member_id = ?").get(householdId, memberId).count;
    const claims = own - bound.claims;
    if (claims > 0) {
      this.db.prepare(`DELETE FROM chat_blob_claims WHERE rowid IN (SELECT rowid FROM chat_blob_claims
        WHERE household_id = ? AND member_id = ? ORDER BY created_at, blob_ref LIMIT ?)`).run(householdId, memberId, claims);
    }
    if (tombstones > 0 || claims > 0)
      this.adjustChatBlobUsage(householdId, { tombstones: -Math.max(0, tombstones), claims: -Math.max(0, claims) });
  },

  /** Whether the running counts match the rows (validate). */
  chatBlobUsageMatches() {
    const drift = this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT h.household_id,
        (SELECT COUNT(*) FROM chat_blobs b WHERE b.household_id = h.household_id AND b.retired = 0) AS actual_live_blobs,
        (SELECT COALESCE(SUM(b.size_bytes), 0) FROM chat_blobs b WHERE b.household_id = h.household_id AND b.retired = 0) AS actual_live_bytes,
        (SELECT COUNT(*) FROM chat_blobs b WHERE b.household_id = h.household_id AND b.retired = 1) AS actual_tombstones,
        (SELECT COUNT(*) FROM chat_blob_claims c WHERE c.household_id = h.household_id) AS actual_claims,
        COALESCE(u.live_blobs, 0) AS counted_live_blobs, COALESCE(u.live_bytes, 0) AS counted_live_bytes,
        COALESCE(u.tombstones, 0) AS counted_tombstones, COALESCE(u.claims, 0) AS counted_claims
      FROM (SELECT household_id FROM chat_blobs UNION SELECT household_id FROM chat_blob_claims UNION SELECT household_id FROM chat_blob_usage) h
      LEFT JOIN chat_blob_usage u ON u.household_id = h.household_id)
      WHERE counted_live_blobs <> actual_live_blobs OR counted_live_bytes <> actual_live_bytes
        OR counted_tombstones <> actual_tombstones OR counted_claims <> actual_claims`).get().count;
    return drift === 0;
  },


  adjustChatBlobUsage(householdId, { liveBlobs = 0, liveBytes = 0, tombstones = 0, claims = 0 }) {
    if (!liveBlobs && !liveBytes && !tombstones && !claims) return;
    // An update first: SQLite checks an upsert's insert row (with negative
    // deltas) before it sees the conflict. A household's first change is
    // always an addition.
    const updated = this.db.prepare(`UPDATE chat_blob_usage SET live_blobs = live_blobs + ?, live_bytes = live_bytes + ?,
      tombstones = tombstones + ?, claims = claims + ? WHERE household_id = ?`)
      .run(liveBlobs, liveBytes, tombstones, claims, householdId).changes;
    if (!updated)
      this.db.prepare("INSERT INTO chat_blob_usage (household_id, live_blobs, live_bytes, tombstones, claims) VALUES (?, ?, ?, ?, ?)")
        .run(householdId, liveBlobs, liveBytes, tombstones, claims);
  },

};
