// Chat content blobs (#110): the encrypted text or attachment of one chat
// message, stored by the SHA-256 of its bytes.
//
// Each message's content is sealed on the device under its own random key,
// which travels only inside the encrypted chat event. The service stores
// ciphertext, checks that it hashes to its reference, and records which
// member and device uploaded it; it never sees a key or any content.
//
// Deleting or editing a message retires its old blob. The service can't read
// events, so the author's device (or an admin's, for a removal) names the
// blobs to retire once the event is stored. Only the member who uploaded a
// blob or a household admin may retire it. A retired blob keeps a tombstone
// row without bytes, so it is never served or accepted again; a read of it
// answers "deleted" (410) rather than "missing" (404), and clients show a
// deleted message instead of an error. A retire that arrives before the
// upload (an offline outbox, a slow upload) is kept as a claim: the upload is
// refused when it comes from the claiming member, or when an admin claimed
// it. A claim by anyone else can't stop another member's upload. Household
// deletion removes every blob, tombstone and claim. Tombstones and claims are
// bounded and the oldest go first, so retiring never fails for space.
import { createHash } from "node:crypto";
import { PairingError, chatAccess, isHouseholdAdmin } from "./pairing-service.mjs";
import { CHAT_UPLOADS_PER_MINUTE, CHAT_UPLOAD_BYTES_PER_TEN_MINUTES, DeviceWindow, chatRateLimited } from "./chat-limits.mjs";
import {
  MAX_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOBS,
  MAX_MEMBER_CHAT_CLAIMS,
  MAX_HOUSEHOLD_CHAT_TOMBSTONES,
  MIN_CHAT_BLOB_BYTES,
} from "./durable-store.mjs";

/** Most references one retire request may name. */
export const MAX_RETIRE_REFS = 64;

const isRef = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new PairingError("chat_blob_invalid", "That chat content could not be verified.", 400);
const deleted = () => new PairingError("chat_blob_deleted", "This message was deleted.", 410);

/**
 * Storage when the service has no durable store (tests, in-memory mode),
 * with the same decisions as durable-store/chat-blobs.mjs.
 */
class MemoryChatBlobStore {
  constructor() {
    this.blobs = new Map();
    this.claims = new Map();
    this.chatBlobLimits = {};
    this.order = 0;
  }
  get limits() {
    return {
      blobs: MAX_HOUSEHOLD_CHAT_BLOBS, bytes: MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
      tombstones: MAX_HOUSEHOLD_CHAT_TOMBSTONES, claims: MAX_MEMBER_CHAT_CLAIMS,
      ...this.chatBlobLimits,
    };
  }
  key(householdId, ref) { return `${householdId}:${ref}`; }
  rows(map, householdId) { return [...map].filter(([key]) => key.startsWith(`${householdId}:`)); }
  chatBlobMeta(householdId, ref) {
    const row = this.blobs.get(this.key(householdId, ref));
    if (!row) return null;
    const { ciphertext, ...rest } = row;
    return rest;
  }
  chatBlobBytes(householdId, ref) {
    const row = this.blobs.get(this.key(householdId, ref));
    return row && !row.retired ? Buffer.from(row.ciphertext) : null;
  }
  chatBlobUsage(householdId) {
    const blobs = this.rows(this.blobs, householdId).map(([, row]) => row);
    const live = blobs.filter((row) => !row.retired);
    return {
      liveBlobs: live.length,
      liveBytes: live.reduce((sum, row) => sum + row.size, 0),
      tombstones: blobs.length - live.length,
      claims: this.rows(this.claims, householdId).reduce((sum, [, members]) => sum + members.size, 0),
    };
  }
  putChatBlob(householdId, ref, ciphertext, { memberId, deviceId, now }) {
    const key = this.key(householdId, ref);
    const existing = this.blobs.get(key);
    if (existing) return existing.retired ? "deleted" : "exists";
    const claims = this.claims.get(key);
    if (claims && [...claims].some(([member, claim]) => member === memberId || claim.byAdmin)) return "deleted";
    const usage = this.chatBlobUsage(householdId);
    if (usage.liveBlobs >= this.limits.blobs || usage.liveBytes + ciphertext.length > this.limits.bytes) return "full";
    this.claims.delete(key);
    this.blobs.set(key, {
      ref, retired: false, size: ciphertext.length, uploaderMemberId: memberId, uploaderDeviceId: deviceId,
      createdAt: now, retiredAt: null, ciphertext: Buffer.from(ciphertext),
    });
    return "accepted";
  }
  retireChatBlobs(householdId, refs, { memberId, admin, now, within = () => {} }) {
    const rows = refs.map((ref) => [ref, this.blobs.get(this.key(householdId, ref))]);
    if (!admin && rows.some(([, row]) => row && !row.retired && row.uploaderMemberId !== memberId)) return "forbidden";
    let retired = 0, claimed = 0, othersRetired = 0;
    for (const [ref, row] of rows) {
      if (row?.retired) continue;
      if (row) {
        row.ciphertext.fill(0);
        Object.assign(row, { retired: true, retiredAt: now, ciphertext: null });
        retired += 1;
        if (row.uploaderMemberId !== memberId) othersRetired += 1;
      } else {
        const key = this.key(householdId, ref);
        if (!this.claims.has(key)) this.claims.set(key, new Map());
        const members = this.claims.get(key);
        if (!members.has(memberId)) claimed += 1;
        members.set(memberId, { byAdmin: members.get(memberId)?.byAdmin || admin, at: now, order: this.order += 1 });
      }
    }
    this.prune(householdId, memberId);
    const result = { retired, claimed, othersRetired };
    within(result);
    return result;
  }
  prune(householdId, memberId) {
    const tombstones = this.rows(this.blobs, householdId).filter(([, row]) => row.retired)
      .sort(([, a], [, b]) => a.retiredAt - b.retiredAt || a.ref.localeCompare(b.ref));
    for (const [key] of tombstones.slice(0, Math.max(0, tombstones.length - this.limits.tombstones))) this.blobs.delete(key);
    const own = this.rows(this.claims, householdId)
      .filter(([, members]) => members.has(memberId))
      .sort(([, a], [, b]) => a.get(memberId).order - b.get(memberId).order);
    for (const [key, members] of own.slice(0, Math.max(0, own.length - this.limits.claims))) {
      members.delete(memberId);
      if (!members.size) this.claims.delete(key);
    }
  }
  forgetHousehold(householdId) {
    for (const [key] of this.rows(this.blobs, householdId)) this.blobs.delete(key);
    for (const [key] of this.rows(this.claims, householdId)) this.claims.delete(key);
  }
}

export class ChatBlobService {
  constructor({ pairingService, store = null, now = () => Date.now() }) {
    this.pairingService = pairingService;
    this.storage = store ?? new MemoryChatBlobStore();
    this.now = now;
    this.uploadWindow = new DeviceWindow({ limit: CHAT_UPLOADS_PER_MINUTE, windowMs: 60_000, now: () => this.now() });
    this.byteWindow = new DeviceWindow({ limit: CHAT_UPLOAD_BYTES_PER_TEN_MINUTES, windowMs: 600_000, now: () => this.now() });
  }

  /** The household's chat content use and its limits, for an admin (#125):
   * totals only, never per person. */
  usage(auth) {
    this.assertCanChat(auth);
    if (!isHouseholdAdmin(auth.member, this.now()))
      throw new PairingError("household_admin_required", "Only a household admin can see chat storage.", 403);
    const usage = this.storage.chatBlobUsage(auth.household.id);
    const limits = this.storage.limits ?? this.storage.chatBlobLimits ?? {};
    return {
      bytes: usage.liveBytes, byteLimit: limits.bytes ?? MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
      blobs: usage.liveBlobs, blobLimit: limits.blobs ?? MAX_HOUSEHOLD_CHAT_BLOBS,
    };
  }

  /** What the admin's chat policy (#123) lets this member do. `need` is
   * "read" or "write" (post, edit, delete, receipts, uploads). */
  assertCanChat(auth, need = "read") {
    const access = chatAccess(auth.member, auth.household, this.now());
    if (access === "none")
      throw new PairingError("chat_unavailable", "Chat isn't available to you in this household.", 403);
    if (need === "write" && access !== "write")
      throw new PairingError("chat_read_only", "Your household has set chat to read-only for you.", 403);
  }

  /** Stores a blob. Uploading the same blob again is a no-op. */
  put(auth, ref, ciphertext) {
    this.assertCanChat(auth, "write");
    if (!isRef(ref) || !Buffer.isBuffer(ciphertext) || ciphertext.length < MIN_CHAT_BLOB_BYTES ||
      ciphertext.length > MAX_CHAT_BLOB_BYTES || createHash("sha256").update(ciphertext).digest("hex") !== ref)
      throw invalid();
    // An upload the service already holds costs nothing.
    // Checked now, charged once the blob is stored: a refused upload (full,
    // deleted) never uses up the allowance.
    const held = Boolean(this.storage.chatBlobMeta(auth.household.id, ref));
    if (!held && !(this.uploadWindow.allows(auth.device.id, 1) && this.byteWindow.allows(auth.device.id, ciphertext.length)))
      throw chatRateLimited("many uploads");
    const outcome = this.storage.putChatBlob(auth.household.id, ref, ciphertext, {
      memberId: auth.member.id, deviceId: auth.device.id, now: this.now(),
    });
    if (outcome === "deleted") throw deleted();
    if (outcome === "full") throw new PairingError("chat_storage_full", "This household's chat storage is full.", 409);
    if (outcome === "accepted") {
      this.uploadWindow.spend(auth.device.id, 1);
      this.byteWindow.spend(auth.device.id, ciphertext.length);
    }
    return { accepted: outcome === "accepted", size: ciphertext.length };
  }

  /** A blob's bytes, re-checked against its reference. */
  get(auth, ref) {
    this.assertCanChat(auth);
    if (!isRef(ref)) throw invalid();
    const row = this.storage.chatBlobMeta(auth.household.id, ref);
    if (!row) throw new PairingError("chat_blob_missing", "This chat content isn't on the server yet.", 404);
    if (row.retired) throw deleted();
    const bytes = this.storage.chatBlobBytes(auth.household.id, ref);
    if (!bytes || bytes.length !== row.size || createHash("sha256").update(bytes).digest("hex") !== ref)
      throw new PairingError("chat_blob_corrupt", "This chat content could not be verified.", 410);
    return bytes;
  }

  /**
   * Retires blobs, all of them or none: each live one must have been
   * uploaded by this member, unless the member is a household admin
   * (removing someone else's message). Blobs not uploaded yet are claimed
   * (see above); already-retired ones are skipped.
   */
  retire(auth, refs) {
    this.assertCanChat(auth, "write");
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_RETIRE_REFS || !refs.every(isRef) ||
      new Set(refs).size !== refs.length)
      throw invalid();
    const householdId = auth.household.id;
    const result = this.storage.retireChatBlobs(householdId, refs, {
      memberId: auth.member.id, admin: isHouseholdAdmin(auth.member, this.now()), now: this.now(),
      // Admin removals are visible to everyone in the chat; the audit
      // records that one happened, never what it was. It is written in the
      // retire's transaction: both happen or neither does.
      within: ({ othersRetired }) => {
        if (!othersRetired) return;
        this.pairingService.audit("chat_content_removed_by_admin", { householdId, memberId: auth.member.id, deviceId: auth.device.id, count: othersRetired });
        this.pairingService.persistHousehold(householdId);
      },
    });
    if (result === "forbidden")
      throw new PairingError("chat_blob_retire_forbidden", "Only the person who sent a message or a household admin can delete its content.", 403);
    return { retired: result.retired, claimed: result.claimed };
  }

  /** In-memory mode only: the durable store purges with the household. */
  forgetHousehold(householdId) {
    this.storage.forgetHousehold?.(householdId);
  }
}
