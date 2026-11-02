// DurableStore problem reports and feature suggestions (#636, ADR 0021 §3).
// server/feedback-service.mjs has the rules; this file holds the two tables
// and their queries.
//
// `feedback` holds one row per report or suggestion: its reference, kind,
// the sender's household and member (both NULL for a report sent without
// signing in, from the lock screen or setup), the time, the bounded JSON
// body, its status, and where forwarding to GitHub stands.
// `feedback_screenshots` holds an optional screenshot per report, apart from
// the row so listing never reads image bytes.
//
// No foreign keys to households or members: like chat_hidden, rows outlive an
// authority restore that rewrites those tables. A household's deletion purges
// its rows (durable-store/lifecycle.mjs purgeHouseholdData); a member's
// removal purges theirs (the service's forgetMember); everything is purged
// 180 days after it arrived. Freed pages are zeroed on purge.
import { DurableStoreError } from "./shared.mjs";

/** The tables, as created by the schema 26 migration and the in-memory
 * store (feedback-service.mjs memoryFeedbackStore). */
export const FEEDBACK_TABLES_SQL = `
  CREATE TABLE feedback (
    reference TEXT PRIMARY KEY CHECK (length(reference) = 17),
    kind TEXT NOT NULL CHECK (kind IN ('problem', 'suggestion')),
    household_id TEXT CHECK (household_id IS NULL OR length(household_id) = 32),
    member_id TEXT CHECK (member_id IS NULL OR length(member_id) = 32),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 16384),
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    has_screenshot INTEGER NOT NULL DEFAULT 0 CHECK (has_screenshot IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'planned', 'done', 'wont_do')),
    status_updated_at INTEGER NOT NULL,
    forward_state TEXT NOT NULL DEFAULT 'off' CHECK (forward_state IN ('off', 'pending', 'sending', 'forwarded', 'failed')),
    forward_attempts INTEGER NOT NULL DEFAULT 0 CHECK (forward_attempts >= 0),
    forward_next_at INTEGER,
    github_issue INTEGER CHECK (github_issue IS NULL OR github_issue >= 1),
    github_status TEXT CHECK (github_status IS NULL OR github_status IN ('received', 'planned', 'done', 'wont_do')),
    github_polled_at INTEGER
  );
  CREATE INDEX feedback_by_member ON feedback(member_id, created_at);
  CREATE INDEX feedback_by_household ON feedback(household_id);
  CREATE INDEX feedback_by_created ON feedback(created_at);
  CREATE INDEX feedback_by_forward ON feedback(forward_state, forward_next_at);
  CREATE TABLE feedback_screenshots (
    reference TEXT PRIMARY KEY REFERENCES feedback(reference) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('image/png', 'image/jpeg')),
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 8 AND 1048576)
  );
`;

const row = (value) => value ? {
  reference: value.reference,
  kind: value.kind,
  householdId: value.household_id,
  memberId: value.member_id,
  createdAt: value.created_at,
  body: value.body,
  bodySha256: value.body_sha256,
  hasScreenshot: value.has_screenshot === 1,
  status: value.status,
  statusUpdatedAt: value.status_updated_at,
  forwardState: value.forward_state,
  forwardAttempts: value.forward_attempts,
  forwardNextAt: value.forward_next_at,
  githubIssue: value.github_issue,
  githubStatus: value.github_status,
  githubPolledAt: value.github_polled_at,
} : null;

/** Deletes rows (and their screenshots) matching `where`, with freed pages
 * zeroed, inside the caller's transaction. */
function purgeWhere(database, where, ...values) {
  const secureDelete = database.prepare("PRAGMA secure_delete").get().secure_delete;
  database.exec("PRAGMA secure_delete = ON");
  try {
    database.prepare(`DELETE FROM feedback_screenshots WHERE reference IN (SELECT reference FROM feedback WHERE ${where})`).run(...values);
    return database.prepare(`DELETE FROM feedback WHERE ${where}`).run(...values).changes;
  } finally {
    database.exec(`PRAGMA secure_delete = ${secureDelete ? "ON" : "OFF"}`);
  }
}

/** A household's reports, deleted with the household (lifecycle.mjs). */
export function purgeHouseholdFeedback(database, householdId) {
  return purgeWhere(database, "household_id = ?", householdId);
}

const FORWARD_FIELDS = Object.freeze({
  forwardState: "forward_state", forwardAttempts: "forward_attempts", forwardNextAt: "forward_next_at",
  githubIssue: "github_issue", githubStatus: "github_status", githubPolledAt: "github_polled_at",
  status: "status", statusUpdatedAt: "status_updated_at",
});

export const feedbackMethods = {
  /** Stores a report: "accepted", or "exists" when the reference is taken. */
  insertFeedback(value, screenshot = null) {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM feedback WHERE reference = ?").get(value.reference)) return "exists";
      this.db.prepare(`INSERT INTO feedback
        (reference, kind, household_id, member_id, created_at, body, body_sha256, has_screenshot, status, status_updated_at, forward_state, forward_next_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`)
        .run(value.reference, value.kind, value.householdId ?? null, value.memberId ?? null, value.createdAt, value.body,
          value.bodySha256, screenshot ? 1 : 0, value.createdAt, value.forwardState ?? "off", value.forwardNextAt ?? null);
      if (screenshot)
        this.db.prepare("INSERT INTO feedback_screenshots(reference, type, bytes) VALUES (?, ?, ?)")
          .run(value.reference, screenshot.type, screenshot.bytes);
      return "accepted";
    });
  },

  feedback(reference) {
    this.assertAvailable();
    return row(this.db.prepare("SELECT * FROM feedback WHERE reference = ?").get(reference));
  },

  feedbackScreenshot(reference) {
    this.assertAvailable();
    const value = this.db.prepare("SELECT type, bytes FROM feedback_screenshots WHERE reference = ?").get(reference);
    return value ? { type: value.type, bytes: Buffer.from(value.bytes) } : null;
  },

  /** How many of `kind` a member sent since `since`. */
  countMemberFeedback(memberId, kind, since) {
    this.assertAvailable();
    return this.db.prepare("SELECT COUNT(*) AS count FROM feedback WHERE member_id = ? AND kind = ? AND created_at > ?")
      .get(memberId, kind, since).count;
  },

  /** A member's own, newest first. */
  memberFeedback(memberId, limit = 100) {
    this.assertAvailable();
    return this.db.prepare("SELECT * FROM feedback WHERE member_id = ? ORDER BY created_at DESC, reference LIMIT ?")
      .all(memberId, limit).map(row);
  },

  /** For the operator: newest first, optionally by kind and status. */
  listFeedback({ kind = null, status = null, limit = 50 } = {}) {
    this.assertAvailable();
    return this.db.prepare(`SELECT * FROM feedback WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR status = ?2)
      ORDER BY created_at DESC, reference LIMIT ?3`).all(kind, status, limit).map(row);
  },

  /** Totals, for the service's storage bounds. */
  feedbackUsage() {
    this.assertAvailable();
    const value = this.db.prepare(`SELECT (SELECT COUNT(*) FROM feedback) AS count,
      (SELECT COALESCE(SUM(length(bytes)), 0) FROM feedback_screenshots) AS screenshotBytes`).get();
    return { count: value.count, screenshotBytes: value.screenshotBytes };
  },

  /** Updates forwarding and status fields of one row; true if it exists. */
  updateFeedback(reference, fields) {
    const sets = [];
    const values = [];
    for (const [name, value] of Object.entries(fields)) {
      const column = FORWARD_FIELDS[name];
      if (!column) throw new DurableStoreError("Kin feedback data is invalid.");
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (!sets.length) return Boolean(this.feedback(reference));
    return this.transaction(() =>
      this.db.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE reference = ?`).run(...values, reference).changes > 0);
  },

  /** Rows due to be forwarded (pending, or caught mid-send), oldest first. */
  feedbackDueForForwarding(now, limit = 10) {
    this.assertAvailable();
    return this.db.prepare(`SELECT * FROM feedback WHERE forward_state IN ('pending', 'sending')
      AND (forward_next_at IS NULL OR forward_next_at <= ?) ORDER BY created_at LIMIT ?`).all(now, limit).map(row);
  },

  /** Forwarded rows whose issue was looked at longest ago. */
  feedbackDueForPolling(before, limit = 20) {
    this.assertAvailable();
    return this.db.prepare(`SELECT * FROM feedback WHERE forward_state = 'forwarded' AND github_issue IS NOT NULL
      AND (github_polled_at IS NULL OR github_polled_at <= ?) ORDER BY COALESCE(github_polled_at, 0), created_at LIMIT ?`)
      .all(before, limit).map(row);
  },

  /** Deletes everything that arrived at or before `cutoff`. */
  purgeFeedbackBefore(cutoff) {
    return this.transaction(() => purgeWhere(this.db, "created_at <= ?", cutoff));
  },

  purgeMemberFeedback(memberId) {
    return this.transaction(() => purgeWhere(this.db, "member_id = ?", memberId));
  },

  purgeFeedbackHousehold(householdId) {
    return this.transaction(() => purgeHouseholdFeedback(this.db, householdId));
  },

  deleteFeedback(reference) {
    return this.transaction(() => purgeWhere(this.db, "reference = ?", reference) > 0);
  },
};
