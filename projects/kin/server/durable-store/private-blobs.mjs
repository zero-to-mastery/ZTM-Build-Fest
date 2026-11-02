// DurableStore private blobs (#502, ADR 0019): a member's encrypted journal
// photos and thumbnails, by the SHA-256 of their sealed bytes, keyed by
// member like the private relay stream (private-blob-service.mjs has the
// rules). One table, `private_blobs`, with the member's household so a
// household's deletion purges it with everything else, and no foreign key to
// members (member removal purges it explicitly, with the stream).
//
// Unlike chat blobs there are no tombstones or claims: only the member's own
// devices ever name a blob, so deleting one simply removes its row. Freed
// pages are zeroed, so the ciphertext doesn't linger in the database file.
import { DurableStoreError, MAX_MEMBER_PRIVATE_BLOB_BYTES, MAX_MEMBER_PRIVATE_BLOBS, isId } from "./shared.mjs";

/** The member bounds; tests lower them through `store.privateBlobLimits`. */
function limits(store) {
  return { blobs: MAX_MEMBER_PRIVATE_BLOBS, bytes: MAX_MEMBER_PRIVATE_BLOB_BYTES, ...store.privateBlobLimits };
}

/** Deletes one member's private blobs inside the caller's transaction. */
export function purgePrivateBlobs(database, memberId) {
  database.prepare("DELETE FROM private_blobs WHERE member_id = ?").run(memberId);
}

export const privateBlobMethods = {
  /** A blob's size and uploader, or null. */
  privateBlobMeta(memberId, ref) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT size_bytes, uploader_device_id, created_at FROM private_blobs WHERE member_id = ? AND blob_ref = ?")
      .get(memberId, ref);
    return row ? { ref, size: row.size_bytes, uploaderDeviceId: row.uploader_device_id, createdAt: row.created_at } : null;
  },

  /** A blob's bytes, or null. */
  privateBlobBytes(memberId, ref) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT ciphertext FROM private_blobs WHERE member_id = ? AND blob_ref = ?").get(memberId, ref);
    return row ? Buffer.from(row.ciphertext) : null;
  },

  /** What a member's blobs use: { blobs, bytes }. */
  privateBlobUsage(memberId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT COUNT(*) AS blobs, COALESCE(SUM(size_bytes), 0) AS bytes FROM private_blobs WHERE member_id = ?").get(memberId);
    return { blobs: row.blobs, bytes: row.bytes };
  },

  get privateBlobBounds() {
    return limits(this);
  },

  /**
   * Stores a member's blob: "accepted", "exists" (already stored) or "full"
   * when the member's quota is reached. The caller has authorized the
   * device and checked the bytes against the reference.
   */
  putPrivateBlob(memberId, ref, ciphertext, { householdId, deviceId, now }) {
    if (!isId(memberId) || !isId(householdId)) throw new DurableStoreError("Kin member data is invalid.");
    return this.transaction(() => {
      if (this.privateBlobMeta(memberId, ref)) return "exists";
      const usage = this.privateBlobUsage(memberId);
      const bound = limits(this);
      if (usage.blobs >= bound.blobs || usage.bytes + ciphertext.length > bound.bytes) return "full";
      this.db.prepare(`INSERT INTO private_blobs
        (member_id, household_id, blob_ref, size_bytes, uploader_device_id, created_at, ciphertext)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(memberId, householdId, ref, ciphertext.length, deviceId, now, ciphertext);
      return "accepted";
    });
  },

  /** Deletes a member's blobs; ones not held are skipped. Returns how many
   * were deleted. */
  retirePrivateBlobs(memberId, refs) {
    this.assertAvailable();
    const secureDelete = this.db.prepare("PRAGMA secure_delete").get().secure_delete;
    this.db.exec("PRAGMA secure_delete = ON");
    try {
      const deleted = this.transaction(() => {
        const remove = this.db.prepare("DELETE FROM private_blobs WHERE member_id = ? AND blob_ref = ?");
        return refs.reduce((sum, ref) => sum + remove.run(memberId, ref).changes, 0);
      });
      if (deleted && !this.db.isTransaction) this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return deleted;
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${secureDelete ? "ON" : "OFF"}`);
    }
  },
};
