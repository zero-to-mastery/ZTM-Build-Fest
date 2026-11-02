// DurableStore calendar subscriptions (#667, ADR 0022 §3): the outside
// calendars members sync. The rules live in calendar-sync-service.mjs; this
// file holds the table and its queries.
//
// A row holds what the service needs to fetch a calendar and say how it
// went, and nothing from the calendar itself: the link (plaintext, because
// the service must fetch it; anyone holding it can read that calendar), the
// owner, the audience ("me" or "household"), when it was added, the last
// fetch's status and error code, when it last succeeded and was last tried,
// how many tries in a row failed, when the service may try again (backoff),
// and the calendar server's ETag. The feed itself is only ever held in the
// service's memory, for at most 30 minutes.
//
// No foreign keys, like feedback: a row never outlives its household, which
// purges it (lifecycle.mjs purgeHouseholdData), or its owner, whose removal
// purges it (calendar-sync-service.mjs forgetMember).
import { DurableStoreError, isId, isTimestamp } from "./shared.mjs";

/** The table, as created by the schema 29 migration. */
export const CALENDAR_SUBSCRIPTIONS_SQL = `
  CREATE TABLE calendar_subscriptions (
    id TEXT PRIMARY KEY CHECK (length(id) = 32),
    household_id TEXT NOT NULL CHECK (length(household_id) = 32),
    owner_member_id TEXT NOT NULL CHECK (length(owner_member_id) = 32),
    audience TEXT NOT NULL CHECK (audience IN ('me', 'household')),
    url TEXT NOT NULL CHECK (length(url) BETWEEN 9 AND 2048 AND substr(url, 1, 8) = 'https://'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    fetch_status TEXT NOT NULL CHECK (fetch_status IN ('pending', 'ok', 'error')),
    fetch_error TEXT CHECK (fetch_error IS NULL OR length(fetch_error) BETWEEN 1 AND 64),
    fetched_at INTEGER CHECK (fetched_at IS NULL OR fetched_at >= 0),
    attempted_at INTEGER CHECK (attempted_at IS NULL OR attempted_at >= 0),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    retry_at INTEGER CHECK (retry_at IS NULL OR retry_at >= 0),
    etag TEXT CHECK (etag IS NULL OR length(etag) BETWEEN 2 AND 256),
    UNIQUE (owner_member_id, url)
  );
  CREATE INDEX calendar_subscriptions_by_household ON calendar_subscriptions(household_id, created_at);
`;

const AUDIENCES = new Set(["me", "household"]);
const STATUSES = new Set(["pending", "ok", "error"]);

function rowValue(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id,
    audience: row.audience,
    url: row.url,
    createdAt: row.created_at,
    status: row.fetch_status,
    error: row.fetch_error,
    fetchedAt: row.fetched_at,
    attemptedAt: row.attempted_at,
    failures: row.failures,
    retryAt: row.retry_at,
    etag: row.etag,
  };
}

const COLUMNS = Object.freeze({
  status: "fetch_status", error: "fetch_error", fetchedAt: "fetched_at", attemptedAt: "attempted_at",
  failures: "failures", retryAt: "retry_at", etag: "etag",
});

export const calendarSubscriptionMethods = {
  insertCalendarSubscription(value) {
    this.assertAvailable();
    if (!isId(value.id) || !isId(value.householdId) || !isId(value.ownerMemberId) || !AUDIENCES.has(value.audience) ||
        typeof value.url !== "string" || !isTimestamp(value.createdAt) || !STATUSES.has(value.status))
      throw new DurableStoreError("Kin could not save that calendar subscription.");
    this.db.prepare(`INSERT INTO calendar_subscriptions
      (id, household_id, owner_member_id, audience, url, created_at, fetch_status, fetch_error, fetched_at, attempted_at,
       failures, retry_at, etag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.householdId, value.ownerMemberId, value.audience, value.url, value.createdAt, value.status,
        value.error ?? null, value.fetchedAt ?? null, value.attemptedAt ?? null, value.failures ?? 0, value.retryAt ?? null,
        value.etag ?? null);
  },

  calendarSubscription(id) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT * FROM calendar_subscriptions WHERE id = ?").get(id);
    return row ? rowValue(row) : null;
  },

  /** A household's subscriptions, oldest first. */
  householdCalendarSubscriptions(householdId) {
    this.assertAvailable();
    return this.db.prepare("SELECT * FROM calendar_subscriptions WHERE household_id = ? ORDER BY created_at, id")
      .all(householdId).map(rowValue);
  },

  /** How many a household has, and how many of them `ownerMemberId` added. */
  countCalendarSubscriptions(householdId, ownerMemberId) {
    this.assertAvailable();
    const row = this.db.prepare(`SELECT COUNT(*) AS household, SUM(owner_member_id = ?) AS member
      FROM calendar_subscriptions WHERE household_id = ?`).get(ownerMemberId, householdId);
    return { household: row.household, member: row.member ?? 0 };
  },

  /** Changes the fetch fields named in `fields` (COLUMNS). */
  updateCalendarSubscription(id, fields) {
    this.assertAvailable();
    const names = Object.keys(fields).filter((name) => COLUMNS[name]);
    if (!names.length) return 0;
    return this.db.prepare(`UPDATE calendar_subscriptions SET ${names.map((name) => `${COLUMNS[name]} = ?`).join(", ")} WHERE id = ?`)
      .run(...names.map((name) => fields[name] ?? (name === "failures" ? 0 : null)), id).changes;
  },

  deleteCalendarSubscription(id) {
    this.assertAvailable();
    return this.db.prepare("DELETE FROM calendar_subscriptions WHERE id = ?").run(id).changes;
  },

  /** Deletes a member's subscriptions; returns their IDs. */
  purgeMemberCalendarSubscriptions(memberId) {
    this.assertAvailable();
    const ids = this.db.prepare("SELECT id FROM calendar_subscriptions WHERE owner_member_id = ?").all(memberId).map((row) => row.id);
    this.db.prepare("DELETE FROM calendar_subscriptions WHERE owner_member_id = ?").run(memberId);
    return ids;
  },

  purgeHouseholdCalendarSubscriptions(householdId) {
    this.assertAvailable();
    return this.db.prepare("DELETE FROM calendar_subscriptions WHERE household_id = ?").run(householdId).changes;
  },
};
