// A member's private blobs (#502, ADR 0019): their journal photos and
// thumbnails, sealed on their device, stored by the SHA-256 of the sealed
// bytes in a store keyed by member, like the private relay stream.
//
// Each photo is sealed under its own random key, which travels only inside
// the journal record, itself sealed under the member key; the service stores
// ciphertext, checks it hashes to its reference, and never sees a key or a
// photo.
//
// Who may: exactly as for the private stream (private-relay-service.mjs
// `assertCanUse`): the session's own member, never a Temporary member, and a
// Limited one only while the household allows private storage. No route
// names a member: each request reaches the session's own member's blobs, so
// another member's device, an admin's included, can't fetch, list or delete
// them (it finds nothing). Removing the member purges their blobs with their
// stream; deleting the household purges every member's.
//
// Deleting: the member's device asks for blobs it no longer needs (a photo
// removed, once its Undo has passed). There are no tombstones: only the
// member's own devices name their blobs.
import { createHash } from "node:crypto";
import { DeviceWindow } from "./chat-limits.mjs";
import {
  MAX_MEMBER_PRIVATE_BLOB_BYTES,
  MAX_MEMBER_PRIVATE_BLOBS,
  MAX_PRIVATE_BLOB_BYTES,
  MIN_PRIVATE_BLOB_BYTES,
} from "./durable-store.mjs";
import { PairingError } from "./pairing-service.mjs";

/** Most references one retire request may name. */
export const MAX_PRIVATE_RETIRE_REFS = 64;
/** Uploads one device may make: per minute, and bytes per ten minutes. */
export const PRIVATE_UPLOADS_PER_MINUTE = 60;
export const PRIVATE_UPLOAD_BYTES_PER_TEN_MINUTES = 128 * 1024 * 1024;

const isRef = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new PairingError("private_blob_invalid", "That photo could not be verified.", 400);

/** Storage when the service has no durable store (tests, in-memory mode),
 * with the same decisions as durable-store/private-blobs.mjs. */
export function memoryPrivateBlobMethods() {
  const members = new Map();
  const of = (memberId) => members.get(memberId) ?? new Map();
  return {
    privateBlobLimits: {},
    get privateBlobBounds() { return { blobs: MAX_MEMBER_PRIVATE_BLOBS, bytes: MAX_MEMBER_PRIVATE_BLOB_BYTES, ...this.privateBlobLimits }; },
    privateBlobMeta(memberId, ref) {
      const row = of(memberId).get(ref);
      return row ? { ref, size: row.ciphertext.length, uploaderDeviceId: row.deviceId, createdAt: row.createdAt } : null;
    },
    privateBlobBytes(memberId, ref) {
      const row = of(memberId).get(ref);
      return row ? Buffer.from(row.ciphertext) : null;
    },
    privateBlobUsage(memberId) {
      const rows = [...of(memberId).values()];
      return { blobs: rows.length, bytes: rows.reduce((sum, row) => sum + row.ciphertext.length, 0) };
    },
    putPrivateBlob(memberId, ref, ciphertext, { householdId, deviceId, now }) {
      if (of(memberId).has(ref)) return "exists";
      const usage = this.privateBlobUsage(memberId);
      const bound = this.privateBlobBounds;
      if (usage.blobs >= bound.blobs || usage.bytes + ciphertext.length > bound.bytes) return "full";
      if (!members.has(memberId)) members.set(memberId, new Map());
      members.get(memberId).set(ref, { householdId, deviceId, createdAt: now, ciphertext: Buffer.from(ciphertext) });
      return "accepted";
    },
    retirePrivateBlobs(memberId, refs) {
      const rows = of(memberId);
      let deleted = 0;
      for (const ref of refs) {
        const row = rows.get(ref);
        if (!row) continue;
        row.ciphertext.fill(0);
        rows.delete(ref);
        deleted += 1;
      }
      return deleted;
    },
    purgePrivateMemberBlobs(memberId) { members.delete(memberId); },
    forgetHouseholdBlobs(householdId) {
      for (const [memberId, rows] of members)
        for (const [ref, row] of rows) if (row.householdId === householdId) { rows.delete(ref); if (!rows.size) members.delete(memberId); }
    },
  };
}

export class PrivateBlobService {
  /** `relay` is the PrivateRelayService: it decides who may use private
   * storage at all. `store` is the DurableStore, or null in memory. */
  constructor({ relay, store = null, now = () => Date.now() }) {
    this.relay = relay;
    this.storage = store ?? memoryPrivateBlobMethods();
    this.now = now;
    this.uploadWindow = new DeviceWindow({ limit: PRIVATE_UPLOADS_PER_MINUTE, windowMs: 60_000, now: () => this.now() });
    this.byteWindow = new DeviceWindow({ limit: PRIVATE_UPLOAD_BYTES_PER_TEN_MINUTES, windowMs: 600_000, now: () => this.now() });
  }

  /** Refuses an upload before its body is read (server.mjs). */
  assertCanUse(auth) {
    this.relay.assertCanUse(auth);
  }

  /** What the member's blobs use and may use, for the private status. */
  usage(auth) {
    const usage = this.storage.privateBlobUsage(auth.member.id);
    const bound = this.storage.privateBlobBounds;
    return { blobBytes: usage.bytes, blobByteLimit: bound.bytes, blobs: usage.blobs, blobLimit: bound.blobs };
  }

  /** Stores one of the member's blobs. Uploading it again is a no-op. */
  put(auth, ref, ciphertext) {
    this.assertCanUse(auth);
    if (!isRef(ref) || !Buffer.isBuffer(ciphertext) || ciphertext.length < MIN_PRIVATE_BLOB_BYTES ||
      ciphertext.length > MAX_PRIVATE_BLOB_BYTES || createHash("sha256").update(ciphertext).digest("hex") !== ref)
      throw invalid();
    // Checked now, charged once stored: a refused upload uses nothing up.
    const held = Boolean(this.storage.privateBlobMeta(auth.member.id, ref));
    if (!held && !(this.uploadWindow.allows(auth.device.id, 1) && this.byteWindow.allows(auth.device.id, ciphertext.length)))
      throw new PairingError("private_rate_limited", "Too many photos too fast. Kin will try again in a moment.", 429);
    const outcome = this.storage.putPrivateBlob(auth.member.id, ref, ciphertext, {
      householdId: auth.household.id, deviceId: auth.device.id, now: this.now(),
    });
    if (outcome === "full")
      throw new PairingError("private_storage_full", "Your journal reached its encrypted photo limit. Remove photos from older entries to add more.", 409);
    if (outcome === "accepted") {
      this.uploadWindow.spend(auth.device.id, 1);
      this.byteWindow.spend(auth.device.id, ciphertext.length);
    }
    return { accepted: outcome === "accepted", size: ciphertext.length };
  }

  /** One of the member's blobs, re-checked against its reference. Another
   * member's blob is simply not there. */
  get(auth, ref) {
    this.assertCanUse(auth);
    if (!isRef(ref)) throw invalid();
    const bytes = this.storage.privateBlobBytes(auth.member.id, ref);
    if (!bytes) throw new PairingError("private_blob_missing", "This photo isn't on the server yet.", 404);
    if (createHash("sha256").update(bytes).digest("hex") !== ref)
      throw new PairingError("private_blob_corrupt", "This photo could not be verified.", 410);
    return bytes;
  }

  /** Deletes some of the member's blobs; ones not held are skipped. */
  retire(auth, refs) {
    this.assertCanUse(auth);
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_PRIVATE_RETIRE_REFS || !refs.every(isRef) ||
      new Set(refs).size !== refs.length)
      throw invalid();
    return { retired: this.storage.retirePrivateBlobs(auth.member.id, refs) };
  }

  /** In-memory mode only: the durable store purges with the stream. */
  forgetMember(memberId) {
    this.storage.purgePrivateMemberBlobs?.(memberId);
  }

  /** In-memory mode only: the durable store purges with the household. */
  forgetHousehold(householdId) {
    this.storage.forgetHouseholdBlobs?.(householdId);
  }
}
