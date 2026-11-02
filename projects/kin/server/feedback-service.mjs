// Problem reports and feature suggestions sent from the app (#635, #636,
// #637, ADR 0021 §3).
//
// What arrives: the person's typed text, the diagnostics they kept in the
// preview (web/feedback/format.js checks each against a fixed table again
// here) and, for a problem report, an optional screenshot (PNG or JPEG, at
// most 1 MiB, its type read from its bytes). Nothing is sent automatically:
// a device sends only after the person pressed Send on a preview.
//
// Who may send: any signed-in member a problem report (POST /api/feedback);
// only a household admin a suggestion; and anyone a problem report without
// signing in (POST /api/feedback/anonymous, from the lock screen or setup),
// which links to no household or member and has tighter address limits.
//
// Limits: 5 reports and 3 suggestions per member per hour (counted from the
// stored rows, so a restart doesn't reset them), 20 per address per day,
// and without signing in 2 per address per hour, 5 per address per day and
// 60 an hour across the service (in memory: a restart forgets those, which
// only ever lets someone send a little sooner). The store is bounded too.
//
// Kept 180 days, then purged; purged at once with the household's deletion
// and with the member on their removal.
//
// Forwarding (when the operator configures it, feedback-github.mjs): each
// report or suggestion becomes an issue with its title, typed text,
// diagnostics and reference, labelled `from-app` and `bug` or `enhancement`.
// Never household or member IDs, usernames or the screenshot. Retried with
// backoff; idempotent by reference (an attempt whose outcome is unknown
// looks the reference up before opening another). Status follows the issue
// (closed as completed → done, closed as not planned → won't do, open with
// the `planned` label → planned) and can be set by the operator's admin
// command; a status the operator set holds until the issue changes.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DeviceWindow } from "./chat-limits.mjs";
import { FEEDBACK_TABLES_SQL, feedbackMethods } from "./durable-store/feedback.mjs";
import { addMethods } from "./mixins.mjs";
import { PairingError } from "./pairing-service.mjs";
import { isHouseholdAdmin } from "./pairing-service/shared.mjs";
import {
  DIAGNOSTIC_FIELDS,
  FEEDBACK_STATUSES,
  FeedbackFormatError,
  MAX_SCREENSHOT_BYTES,
  RECENT_LABEL,
  SCREENSHOT_TYPES,
  TEXT_FIELDS,
  formatDiagnostic,
  isReference,
  normalizeReport,
  reportTitle,
  sniffImageType,
} from "../web/feedback/format.js";
import { entryLine } from "../web/diagnostics/registry.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const FEEDBACK_RETENTION_MS = 180 * DAY_MS;
export const FEEDBACK_LIMITS = Object.freeze({
  problemsPerMemberHour: 5,
  suggestionsPerMemberHour: 3,
  perAddressDay: 20,
  anonymousPerAddressHour: 2,
  anonymousPerAddressDay: 5,
  anonymousPerServiceHour: 60,
});
/** Bounds on what the service keeps, whatever the rate. */
export const MAX_STORED_FEEDBACK = 20_000;
export const MAX_SCREENSHOT_STORAGE_BYTES = 1024 * 1024 * 1024;
/** The request body: 16 KiB of report plus a base64 screenshot. */
export const MAX_FEEDBACK_REQUEST_BYTES = 64 * 1024 + Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3);
/** Forwarding gives up after this many attempts (the admin command can
 * forward again). */
export const MAX_FORWARD_ATTEMPTS = 8;
/** How often issues are looked at for a status change, and how many at once. */
export const POLL_INTERVAL_MS = 15 * 60_000;
const POLL_BATCH = 20;
const FORWARD_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = HOUR_MS;
const VISIBILITY_TTL_MS = HOUR_MS;
export const FORWARD_LABELS = Object.freeze({ problem: ["from-app", "bug"], suggestion: ["from-app", "enhancement"] });

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

class MemoryFeedbackStore {
  constructor() {
    this.db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    this.db.exec(FEEDBACK_TABLES_SQL);
    this.depth = 0;
  }

  assertAvailable() {}

  transaction(operation) {
    const savepoint = `kin_feedback_${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = operation();
      this.db.exec(this.depth === 1 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(this.depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
}
addMethods(MemoryFeedbackStore, feedbackMethods);

/** Storage when the service has no durable store (tests, in-memory mode),
 * with the same tables and queries as the durable one. */
export function memoryFeedbackStore() {
  return new MemoryFeedbackStore();
}

const refused = (code, message, status = 400) => new PairingError(code, message, status);
const rateLimited = () => refused("feedback_rate_limited", "You've sent several reports recently. Kin will keep this one and try again later.", 429);

/** The status an issue's state stands for. */
export function statusFromIssue({ state, stateReason, labels }) {
  if (state === "closed") return stateReason === "not_planned" ? "wont_do" : "done";
  return labels.includes("planned") ? "planned" : "received";
}

/** A fenced block GitHub shows as typed: no Markdown, links or mentions. */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** The issue for a stored report: title, body and labels. Built from the
 * stored body only, which holds no household or member ID or username. */
export function issueFor(report) {
  const title = `[${report.reference}] ${reportTitle(report)}`;
  const lines = [`**Reference:** ${report.reference}`, `**Kind:** ${report.kind === "problem" ? "Problem report" : "Feature suggestion"}`, ""];
  for (const field of TEXT_FIELDS[report.kind]) {
    const value = report.text[field.name];
    lines.push(`### ${field.label}`, value ? fenced(value) : "_Nothing typed._", "");
  }
  const diagnostics = Object.entries(DIAGNOSTIC_FIELDS).filter(([key]) => report.diagnostics[key] !== undefined);
  if (diagnostics.length) {
    lines.push("### Diagnostics", "", "| Detail | Value |", "| --- | --- |");
    for (const [key, { label }] of diagnostics) lines.push(`| ${label} | ${formatDiagnostic(key, report.diagnostics[key]).replaceAll("|", "\\|")} |`);
    lines.push("");
  }
  if (report.diagnostics.recent?.length) {
    lines.push(`### ${RECENT_LABEL} (${report.diagnostics.recent.length})`, fenced(report.diagnostics.recent.map(entryLine).join("\n")), "");
  }
  lines.push("_Sent from Kin after the person previewed it. Any screenshot stays on the Kin service._");
  return { title, body: lines.join("\n"), labels: [...FORWARD_LABELS[report.kind]] };
}

export class FeedbackService {
  /**
   * `store` is the DurableStore or null (in memory). `github` is a
   * GitHubIssues client or null when forwarding is off.
   */
  constructor({ store = null, github = null, now = () => Date.now(), log = (event) => console.error(JSON.stringify(event)) } = {}) {
    this.storage = store ?? memoryFeedbackStore();
    this.github = github;
    this.now = now;
    this.log = log;
    const window = (limit, windowMs) => new DeviceWindow({ limit, windowMs, now: () => this.now() });
    this.addressDay = window(FEEDBACK_LIMITS.perAddressDay, DAY_MS);
    this.anonymousHour = window(FEEDBACK_LIMITS.anonymousPerAddressHour, HOUR_MS);
    this.anonymousDay = window(FEEDBACK_LIMITS.anonymousPerAddressDay, DAY_MS);
    this.anonymousService = window(FEEDBACK_LIMITS.anonymousPerServiceHour, HOUR_MS);
    this.trackerPublic = null;
    this.visibilityCheckedAt = -Infinity;
    this.forwarding = null;
    this.polling = null;
    this.timers = [];
  }

  /** Where reports go, for the device's preview. */
  async channel() {
    if (!this.github) return { forwarding: false, trackerPublic: null };
    if (this.now() - this.visibilityCheckedAt > VISIBILITY_TTL_MS) {
      this.visibilityCheckedAt = this.now();
      try {
        const isPrivate = await this.github.repositoryPrivate();
        this.trackerPublic = isPrivate === null ? null : !isPrivate;
      } catch {
        // Unknown reads as possibly public in the preview.
        this.trackerPublic = null;
      }
    }
    return { forwarding: true, trackerPublic: this.trackerPublic };
  }

  /** Refuses an anonymous report before its body is read. */
  assertAnonymousAllowed(clientKey) {
    if (!this.anonymousService.allows("service") || !this.anonymousHour.allows(clientKey) ||
      !this.anonymousDay.allows(clientKey) || !this.addressDay.allows(clientKey))
      throw rateLimited();
  }

  /** Refuses a signed-in report before its body is read. */
  assertSignedAllowed(clientKey) {
    if (!this.addressDay.allows(clientKey)) throw rateLimited();
  }

  /**
   * Stores one report or suggestion. `auth` is the session's
   * { household, member } or null for the anonymous route. Resolves
   * { reference, status, duplicate }.
   */
  submit({ auth = null, body, clientKey = "unknown" }) {
    let report;
    try {
      report = normalizeReport(body);
    } catch (error) {
      if (error instanceof FeedbackFormatError)
        throw refused(error.code, error.message, error.code === "feedback_too_large" ? 413 : 400);
      throw error;
    }
    if (report.kind === "suggestion") {
      if (!auth) throw refused("authentication_required", "Sign in to suggest something.", 401);
      if (!isHouseholdAdmin(auth.member, this.now()))
        throw refused("feedback_admin_only", "Only a household admin can suggest features from Kin.", 403);
    }
    const screenshot = report.kind === "problem" ? this.screenshot(body.screenshot) : null;
    if (body.screenshot !== undefined && body.screenshot !== null && report.kind !== "problem")
      throw refused("feedback_invalid", "Only a problem report can include a screenshot.");
    const stored = JSON.stringify(report);
    const digest = sha256(screenshot ? `${stored}\n${sha256(screenshot.bytes)}` : stored);
    const memberId = auth?.member.id ?? null;
    const existing = this.storage.feedback(report.reference);
    if (existing) {
      // The outbox sent it again (its first answer was lost): same sender,
      // same content, same answer.
      if (existing.memberId === memberId && existing.bodySha256 === digest)
        return { reference: existing.reference, status: existing.status, duplicate: true };
      throw refused("feedback_reference_taken", "That reference is already in use. Send the report again to get a new one.", 409);
    }
    const now = this.now();
    if (auth) {
      const limit = report.kind === "problem" ? FEEDBACK_LIMITS.problemsPerMemberHour : FEEDBACK_LIMITS.suggestionsPerMemberHour;
      if (this.storage.countMemberFeedback(memberId, report.kind, now - HOUR_MS) >= limit) throw rateLimited();
      this.assertSignedAllowed(clientKey);
    } else this.assertAnonymousAllowed(clientKey);
    const usage = this.storage.feedbackUsage();
    if (usage.count >= MAX_STORED_FEEDBACK || (screenshot && usage.screenshotBytes + screenshot.bytes.length > MAX_SCREENSHOT_STORAGE_BYTES))
      throw refused("feedback_full", "Kin's service can't take more reports right now. Try again later.", 503);
    this.storage.insertFeedback({
      reference: report.reference, kind: report.kind, householdId: auth?.household.id ?? null, memberId,
      createdAt: now, body: stored, bodySha256: digest,
      forwardState: this.github ? "pending" : "off", forwardNextAt: this.github ? now : null,
    }, screenshot);
    this.addressDay.spend(clientKey);
    if (!auth) {
      this.anonymousHour.spend(clientKey);
      this.anonymousDay.spend(clientKey);
      this.anonymousService.spend("service");
    }
    if (this.github) this.forwardSoon();
    return { reference: report.reference, status: "received", duplicate: false };
  }

  /** A screenshot as sent ({ type, data: base64 }), checked, or null. */
  screenshot(value) {
    if (value === undefined || value === null) return null;
    const invalid = () => refused("feedback_screenshot_invalid", "The screenshot must be a PNG or JPEG image of at most 1 MB.");
    if (typeof value !== "object" || !SCREENSHOT_TYPES.includes(value.type) || typeof value.data !== "string" ||
      value.data.length > Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
      throw invalid();
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.length < 8 || bytes.length > MAX_SCREENSHOT_BYTES || bytes.toString("base64") !== value.data ||
      sniffImageType(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)) !== value.type)
      throw invalid();
    return { type: value.type, bytes };
  }

  /** The member's own reports and suggestions, for "What I've sent". */
  mine(auth) {
    return {
      items: this.storage.memberFeedback(auth.member.id).map((row) => {
        const report = JSON.parse(row.body);
        return { reference: row.reference, kind: row.kind, createdAt: row.createdAt, status: row.status,
          statusUpdatedAt: row.statusUpdatedAt, title: reportTitle(report) };
      }),
    };
  }

  /** One stored report for the operator, with the body parsed. */
  show(reference) {
    if (!isReference(reference)) return null;
    const row = this.storage.feedback(reference);
    if (!row) return null;
    const { body, bodySha256, ...rest } = row;
    return { ...rest, report: JSON.parse(body) };
  }

  list(options) {
    return this.storage.listFeedback(options).map(({ body, bodySha256, ...rest }) => ({ ...rest, title: reportTitle(JSON.parse(body)) }));
  }

  /** Sets a status (the operator's admin command). */
  setStatus(reference, status) {
    if (!isReference(reference) || !FEEDBACK_STATUSES.includes(status)) throw refused("feedback_invalid", "Unknown reference or status.");
    return this.storage.updateFeedback(reference, { status, statusUpdatedAt: this.now() });
  }

  /** Purges everything older than the retention period. */
  purgeExpired() {
    return this.storage.purgeFeedbackBefore(this.now() - FEEDBACK_RETENTION_MS);
  }

  /** A removed member's reports go with them (in the removal's transaction). */
  forgetMember(memberId) {
    this.storage.purgeMemberFeedback(memberId);
  }

  /** A deleted household's reports. The durable store also purges them in
   * purgeHouseholdData; this covers the in-memory store. */
  forgetHousehold(householdId) {
    this.storage.purgeFeedbackHousehold(householdId);
  }

  /** Starts forwarding soon, without waiting for it. */
  forwardSoon() {
    queueMicrotask(() => void this.forwardDue().catch(() => {}));
  }

  /** Forwards what is due; one run at a time. Resolves how many went out. */
  forwardDue() {
    if (!this.github) return Promise.resolve(0);
    if (this.forwarding) return this.forwarding;
    this.forwarding = (async () => {
      let sent = 0;
      for (const row of this.storage.feedbackDueForForwarding(this.now(), 10)) {
        if (await this.forwardOne(row)) sent += 1;
      }
      return sent;
    })().finally(() => { this.forwarding = null; });
    return this.forwarding;
  }

  /**
   * Forwards one stored row now (also the admin command's `feedback-forward`).
   * Resolves true when an issue exists for it afterwards.
   */
  async forwardOne(row) {
    if (!this.github) throw refused("feedback_forwarding_off", "Forwarding to GitHub is not configured.", 409);
    if (row.forwardState === "forwarded" && row.githubIssue) return true;
    const report = JSON.parse(row.body);
    const attempts = row.forwardAttempts + 1;
    try {
      // An earlier attempt may have opened the issue without hearing back.
      let number = row.forwardAttempts > 0 || row.forwardState === "sending"
        ? await this.github.findIssue(row.reference, { label: "from-app", sinceMs: row.createdAt })
        : null;
      if (!number) {
        this.storage.updateFeedback(row.reference, { forwardState: "sending", forwardAttempts: attempts });
        number = await this.github.createIssue(issueFor(report));
      }
      this.storage.updateFeedback(row.reference, { forwardState: "forwarded", forwardAttempts: attempts, forwardNextAt: null, githubIssue: number });
      this.log({ event: "feedback_forwarded", outcome: "ok" });
      return true;
    } catch (error) {
      // The row may have been purged meanwhile; then there is nothing to do.
      if (!this.storage.feedback(row.reference)) return false;
      const failed = attempts >= MAX_FORWARD_ATTEMPTS || (error?.status >= 400 && error.status < 500 && error.status !== 429 && !error.retryable);
      const delay = Math.min(6 * HOUR_MS, 60_000 * 2 ** Math.min(attempts, 10));
      this.storage.updateFeedback(row.reference, failed
        ? { forwardState: "failed", forwardAttempts: attempts, forwardNextAt: null }
        : { forwardState: "pending", forwardAttempts: attempts, forwardNextAt: this.now() + delay });
      this.log({ event: "feedback_forward_failed", outcome: failed ? "gave_up" : "retry", status: Number.isInteger(error?.status) ? error.status : 0 });
      return false;
    }
  }

  /** Looks at forwarded issues for status changes; one run at a time. */
  pollStatuses() {
    if (!this.github) return Promise.resolve(0);
    if (this.polling) return this.polling;
    this.polling = (async () => {
      let changed = 0;
      const now = this.now();
      for (const row of this.storage.feedbackDueForPolling(now - POLL_INTERVAL_MS + 1000, POLL_BATCH)) {
        let issue;
        try { issue = await this.github.issueState(row.githubIssue); } catch { continue; }
        const derived = statusFromIssue(issue);
        // Only a change on GitHub moves the status, so one the operator set
        // with the admin command holds until the issue itself changes.
        if (derived !== (row.githubStatus ?? "received")) {
          this.storage.updateFeedback(row.reference, { githubStatus: derived, status: derived, statusUpdatedAt: this.now(), githubPolledAt: this.now() });
          changed += 1;
        } else this.storage.updateFeedback(row.reference, { githubPolledAt: this.now() });
      }
      return changed;
    })().finally(() => { this.polling = null; });
    return this.polling;
  }

  /** Starts the retention purge and, when forwarding is on, the forwarding
   * and status timers. Timers don't keep the process alive. */
  start() {
    const every = (ms, task) => {
      const timer = setInterval(() => { try { void Promise.resolve(task()).catch(() => {}); } catch { /* next time */ } }, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(RETENTION_INTERVAL_MS, () => this.purgeExpired());
    if (this.github) {
      every(FORWARD_INTERVAL_MS, () => this.forwardDue());
      every(POLL_INTERVAL_MS, () => this.pollStatuses());
    }
    try { this.purgeExpired(); } catch { /* the hourly run tries again */ }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
