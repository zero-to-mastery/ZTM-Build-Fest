// DurableStore prepared invitations (#613, "Set up Kin for someone"): the one
// kind of pairing the service keeps across a restart, so an invitation an
// admin printed and posted still works when it arrives. The rules live in
// pairing-service/create.mjs; this file holds the table and its queries.
//
// A row holds what the service needs to accept the code and admit the
// member: the household, the inviting member and device (and that device's
// key fingerprint, which the joiner compares), the code's verifier (a
// domain-separated SHA-256, never the code), the member kind and a
// Temporary member's end, whether the person starts in easy mode, and the
// sealed card (the person's name, the helper's name and a note), encrypted
// on the admin's device under a key that only the link's fragment carries.
// A row goes as soon as its code stops working (approved, cancelled,
// expired), with the household, and when it expires.
//
// No foreign keys, like feedback: a row never outlives its household, which
// purges it (lifecycle.mjs purgeHouseholdData).
import { DurableStoreError, isId, isTimestamp } from "./shared.mjs";

/** The table, as created by the schema 27 migration. */
export const PREPARED_INVITATIONS_SQL = `
  CREATE TABLE prepared_invitations (
    id TEXT PRIMARY KEY CHECK (length(id) = 32),
    household_id TEXT NOT NULL CHECK (length(household_id) = 32),
    inviter_member_id TEXT NOT NULL CHECK (length(inviter_member_id) = 32),
    inviter_device_id TEXT NOT NULL CHECK (length(inviter_device_id) = 32),
    inviter_key_fingerprint TEXT CHECK (inviter_key_fingerprint IS NULL OR length(inviter_key_fingerprint) = 64),
    verifier TEXT NOT NULL UNIQUE CHECK (length(verifier) = 64),
    member_kind TEXT NOT NULL CHECK (member_kind IN ('adult', 'limited', 'temporary')),
    member_expires_at INTEGER CHECK ((member_kind = 'temporary') = (member_expires_at IS NOT NULL)),
    easy_mode INTEGER NOT NULL CHECK (easy_mode IN (0, 1)),
    card TEXT CHECK (card IS NULL OR length(card) BETWEEN 40 AND 2048),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
  );
  CREATE INDEX prepared_invitations_by_household ON prepared_invitations(household_id);
`;

const HEX64 = /^[a-f0-9]{64}$/;

function rowValue(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    inviterMemberId: row.inviter_member_id,
    inviterDeviceId: row.inviter_device_id,
    inviterKeyFingerprint: row.inviter_key_fingerprint,
    verifier: row.verifier,
    memberKind: row.member_kind,
    memberExpiresAt: row.member_expires_at,
    easyMode: row.easy_mode === 1,
    card: row.card,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export const preparedInvitationMethods = {
  insertPreparedInvitation(value) {
    this.assertAvailable();
    if (!isId(value.id) || !isId(value.householdId) || !isId(value.inviterMemberId) || !isId(value.inviterDeviceId) ||
        !HEX64.test(value.verifier) || !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt))
      throw new DurableStoreError("Kin could not save that invitation.");
    this.db.prepare(`INSERT INTO prepared_invitations
      (id, household_id, inviter_member_id, inviter_device_id, inviter_key_fingerprint, verifier, member_kind,
       member_expires_at, easy_mode, card, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.householdId, value.inviterMemberId, value.inviterDeviceId, value.inviterKeyFingerprint ?? null,
        value.verifier, value.memberKind, value.memberExpiresAt ?? null, value.easyMode ? 1 : 0, value.card ?? null,
        value.createdAt, value.expiresAt);
  },

  deletePreparedInvitation(id) {
    this.assertAvailable();
    return this.db.prepare("DELETE FROM prepared_invitations WHERE id = ?").run(id).changes;
  },

  /** The invitations still open at `now`; expired ones are deleted. */
  loadPreparedInvitations(now) {
    this.assertAvailable();
    this.db.prepare("DELETE FROM prepared_invitations WHERE expires_at <= ?").run(now);
    return this.db.prepare("SELECT * FROM prepared_invitations ORDER BY created_at, id").all().map(rowValue);
  },
};
