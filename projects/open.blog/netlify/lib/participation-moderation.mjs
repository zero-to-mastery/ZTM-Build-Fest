// The one moderation state machine for every participation kind (ADRs 0102 to 0105), as the
// hosted function applies it: the same rules as `openblog_core::moderation`, held together by
// tests/fixtures/participation-transitions.json, which the Rust policy generates and this module
// must agree with case by case. Reasons are moderation grounds, never a verdict on facts.
//
// Admin decides first, with the viewer's role on the item's work; the function decides again here
// from the stored row before anything is written, and the database applies the change only while
// the row still has the state and version both saw.

export const MODERATION_STATES = Object.freeze(["pending", "clarification", "approved", "rejected", "removed", "withdrawn"]);
export const MODERATION_ACTIONS = Object.freeze(["approve", "reject", "request-clarification", "clarify", "remove", "reopen", "withdraw", "expire", "uphold-report"]);
// What the inbox asks the function to store; the rest belong to readers, retention and reports.
export const INBOX_ACTIONS = Object.freeze(["approve", "request-clarification", "reject", "remove", "reopen"]);
// The roles Admin may name for an inbox decision (ADR 0103). The token itself is the site Admin.
export const MODERATOR_ROLES = Object.freeze(["site-admin", "coordinator"]);

// The fixed rules of each kind (ADR 0101): whether an approved item may be shown, and whether a
// moderator may ask its submitter to clarify.
const KIND_RULES = Object.freeze({
  comment: { publishable: true, clarification: false },
  question: { publishable: true, clarification: true },
  "source-suggestion": { publishable: true, clarification: true },
  "correction-suggestion": { publishable: true, clarification: true },
  "alternative-interpretation": { publishable: true, clarification: true },
  "third-perspective": { publishable: true, clarification: true },
  "author-response": { publishable: true, clarification: false },
  "abuse-report": { publishable: false, clarification: false },
  // Approval admits it to the editors' private queue; it is never public (ADR 0152).
  "future-suggestion": { publishable: false, editorial: true, clarification: true },
});
export const PARTICIPATION_KINDS = Object.freeze(Object.keys(KIND_RULES));

/**
 * Whether an approved item of `kind` may ever be shown to readers: `KindRules::publishable`. An
 * editorial kind (a suggestion for future work) is approved into the editors' private queue and an
 * abuse report is never public, so neither is, whatever their state; a kind this code does not know
 * is not. Anything that says an item is "published" or "shown" must ask this first.
 */
export function isPublishable(kind) {
  return Object.hasOwn(KIND_RULES, kind) && KIND_RULES[kind].publishable === true;
}

const DECLINE = Object.freeze(["spam", "abusive", "personal-data", "off-topic", "duplicate", "rights", "other"]);
const DISMISS_REPORT = Object.freeze(["no-action", "duplicate", "spam", "other"]);
const CLARIFY = Object.freeze(["unclear", "needs-source", "personal-data", "other"]);
const UPHOLD = Object.freeze(["spam", "abusive", "personal-data", "off-topic", "rights", "other"]);

/** The reasons a request may give for `action` on `kind`; empty means it must give none. */
export function allowedReasons(action, kind) {
  if (action === "reject") return kind === "abuse-report" ? DISMISS_REPORT : DECLINE;
  if (action === "remove") return DECLINE;
  if (action === "request-clarification") return CLARIFY;
  if (action === "uphold-report") return UPHOLD;
  return [];
}

const GRANTS = Object.freeze({
  "site-admin": ["approve", "reject", "request-clarification", "remove", "reopen", "uphold-report"],
  coordinator: ["approve", "reject", "request-clarification", "remove", "uphold-report"],
  submitter: ["clarify", "withdraw"],
  system: ["expire"],
});

function applies(kind, action) {
  const rules = KIND_RULES[kind];
  if (action === "approve") return kind !== "abuse-report";
  if (action === "uphold-report") return kind === "abuse-report";
  if (action === "request-clarification" || action === "clarify") return rules.clarification;
  if (action === "remove") return rules.publishable || rules.editorial === true;
  return true;
}

/** The state machine: the next state, or null when the action does not apply from `from`. */
export function nextState(action, from) {
  if ((action === "approve" || action === "uphold-report") && from === "pending") return "approved";
  if ((action === "reject" || action === "expire") && (from === "pending" || from === "clarification")) return "rejected";
  if (action === "request-clarification" && from === "pending") return "clarification";
  if (action === "clarify" && from === "clarification") return "pending";
  if (action === "remove" && from === "approved") return "removed";
  if (action === "reopen" && (from === "rejected" || from === "removed")) return "pending";
  if (action === "withdraw" && (from === "pending" || from === "clarification" || from === "approved")) return "withdrawn";
  return null;
}

const refuse = (code) => ({ ok: false, code });

/**
 * Decide one request on a stored item, in the policy's fixed order: grant, kind, version, state
 * (with the clarification rule), reason, consent, retained text. `item` is `{kind, state, version,
 * revision, clarificationAsked, clarificationConsent, contentRetained}`; `request` is `{action,
 * expectedVersion, reason, role}`. On success the change names everything the row must become.
 */
export function planTransition(item, request) {
  const kind = Object.hasOwn(KIND_RULES, item?.kind) ? item.kind : null;
  const action = MODERATION_ACTIONS.includes(request?.action) ? request.action : null;
  if (!kind || !action || !MODERATION_STATES.includes(item.state)) return refuse("notAllowed");
  const grants = Object.hasOwn(GRANTS, request.role) ? GRANTS[request.role] : [];
  if (!grants.includes(action)) return refuse("denied");
  if (!applies(kind, action)) return refuse("notAllowed");
  if (request.expectedVersion !== item.version) return refuse("stale");
  let to = nextState(action, item.state);
  if (!to) return refuse("notAllowed");
  // The text a clarification asked about is never approved, whatever happened since (ADR 0102).
  const asked = item.clarificationAsked != null && item.clarificationAsked === item.revision;
  if (action === "approve" && asked) return refuse("notAllowed");
  if (action === "reopen" && asked) to = "clarification";
  const allowed = allowedReasons(action, kind);
  const reason = request.reason === undefined || request.reason === null || request.reason === "" ? null : request.reason;
  if (reason === null && allowed.length) return refuse("reasonRequired");
  if (reason !== null && !allowed.includes(reason)) return refuse("reasonNotAllowed");
  if (action === "request-clarification" && item.clarificationConsent !== true) return refuse("consentRequired");
  if (item.contentRetained === false) return refuse("contentPurged");
  const revision = action === "clarify" ? item.revision + 1 : item.revision;
  return {
    ok: true,
    change: {
      action,
      from: item.state,
      to,
      reason,
      version: item.version + 1,
      revision,
      approvedRevision: to === "approved" ? revision : null,
      clarificationAsked: action === "request-clarification" ? item.revision : item.clarificationAsked ?? null,
    },
  };
}

/** The value the existing `openblog_comments.status` column can hold for a state (ADR 0102). */
export function legacyCommentStatus(state) {
  if (state === "pending" || state === "clarification") return "pending";
  if (state === "approved") return "approved";
  return "rejected";
}

// The four states a comment can be in (ADR 0106): it never waits for clarification and is never
// withdrawn.
export const COMMENT_STATES = Object.freeze(["pending", "approved", "rejected", "removed"]);

/**
 * A comment's state from its two columns (ADR 0106). `moderation_state` is trusted only while
 * `status` still holds its legacy value: a write made while OPENBLOG_MODERATION_ENABLED was off
 * changes `status` alone, and the state it left behind is then out of date, so `status` decides.
 */
export function commentState(moderationState, status) {
  if (MODERATION_STATES.includes(moderationState) && legacyCommentStatus(moderationState) === status) return moderationState;
  return status;
}

/**
 * The PostgREST condition for comments in `state` under the full schema, matching exactly the rows
 * `commentState` reads as `state`; null when no comment can be in it.
 */
export function commentStateFilter(state) {
  if (!COMMENT_STATES.includes(state)) return null;
  const status = legacyCommentStatus(state);
  if (state !== status) return `and(status.eq.${status},moderation_state.eq.${state})`;
  // Every other state stored under this status, which, when current, wins over it.
  const others = MODERATION_STATES.filter((other) => other !== state && legacyCommentStatus(other) === status);
  if (!others.length) return `status.eq.${status}`;
  return `and(status.eq.${status},or(moderation_state.is.null,moderation_state.not.in.(${others.join(",")})))`;
}

/**
 * Whether an older hosted schema can store `action` on `kind` (ADR 0106): comments can be approved,
 * rejected, removed (stored as rejected) and reopened; passage feedback approved, rejected and
 * removed (ADR 0083).
 */
export function legacySupports(kind, action) {
  if (kind === "comment") return ["approve", "reject", "remove", "reopen"].includes(action);
  return ["question", "source-suggestion", "correction-suggestion", "alternative-interpretation"].includes(kind)
    && ["approve", "reject", "remove"].includes(action);
}

// ---- Engagement protection (ADRs 0107 and 0108)

/** The grounds a reader may give for an abuse report: the reasons a moderator may uphold one for. */
export const REPORT_GROUNDS = UPHOLD;

/** Whether a kind's submitters get a private receipt: the reader kinds that may be asked to clarify. */
export function issuesReceipts(kind) {
  return Object.hasOwn(KIND_RULES, kind) && KIND_RULES[kind].clarification;
}

const ROW_TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/;
/** A stored time as a UTC key to the microsecond that sorts as text, or null. */
export function timeKey(value) {
  const match = ROW_TIME.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(`${match[1]}${match[3]}`);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}.${(match[2] || "").padEnd(6, "0")}Z`;
}

/**
 * The step one retention run owes an item, or null (ADR 0104): `item` is `{kind, state, since,
 * retained}`, `cutoffs` the run's `{pendingUntil, clarificationUntil, closedUntil, comments}`. An
 * item is due when its state began at or before its step's time. Comments are covered only when
 * the site set retention itself; an approved item is kept while it can be published. An approved
 * editorial item (a suggestion for future work) is kept too, but owes `scrub-identity`, the
 * clearing of its private contact and unpublished name, once the closed-item period has passed
 * since its approval (ADR 0155), or at once when `item.linked` says an author linked it to future
 * work; `item.identityHeld === false` says it holds none, so it owes nothing (a fixture row, which says nothing of it, is due as the policy decides).
 */
export function retentionStep(item, cutoffs) {
  const kind = Object.hasOwn(KIND_RULES, item?.kind) ? item.kind : null;
  if (!kind || !MODERATION_STATES.includes(item.state)) return null;
  if (kind === "comment" && cutoffs?.comments !== true) return null;
  const since = timeKey(item.since);
  const due = (until) => since !== null && timeKey(until) !== null && since <= timeKey(until);
  const retained = item.retained !== false;
  if (item.state === "pending") return due(cutoffs.pendingUntil) ? "expire" : null;
  if (item.state === "clarification") return due(cutoffs.clarificationUntil) ? "expire" : null;
  if (item.state === "withdrawn") return retained ? "purge-content" : null;
  if (item.state === "approved" && KIND_RULES[kind].publishable) return null;
  if (item.state === "approved" && KIND_RULES[kind].editorial === true) {
    // One an author linked to future work (`item.linked`) owes the clearing at once (ADR 0163).
    return retained && item.identityHeld !== false && (item.linked === true || due(cutoffs.closedUntil)) ? "scrub-identity" : null;
  }
  return retained && due(cutoffs.closedUntil) ? "purge-content" : null;
}

/**
 * A deletion request (ADR 0107), as `ModerationPolicy::erase` decides it: the submitter, by their
 * receipt, for any of their items (one still open or approved is withdrawn first); the site
 * Admin only for an item already closed or an upheld report. `item` is `{kind, state, version,
 * retained}`. On success it says whether a withdrawal comes first, the state afterwards and the
 * version afterwards.
 */
export function planErasure(item, role, expectedVersion) {
  const kind = Object.hasOwn(KIND_RULES, item?.kind) ? item.kind : null;
  if (!kind || !MODERATION_STATES.includes(item.state)) return refuse("notAllowed");
  const permitted = role === "submitter" ? issuesReceipts(kind) : role === "site-admin";
  if (!permitted) return refuse("denied");
  if (expectedVersion !== item.version) return refuse("stale");
  if (item.retained === false) return refuse("contentPurged");
  let withdraw = false;
  if (role === "submitter") {
    withdraw = ["pending", "clarification", "approved"].includes(item.state);
  } else if (!["rejected", "removed", "withdrawn"].includes(item.state) && !(item.state === "approved" && !KIND_RULES[kind].publishable && KIND_RULES[kind].editorial !== true)) {
    return refuse("notAllowed");
  }
  return { ok: true, withdraw, to: withdraw ? "withdrawn" : item.state, version: item.version + (withdraw ? 2 : 1) };
}

/**
 * Upholding an abuse report (ADR 0104), in the policy's order, with the item the report names as
 * the hosted function read it: `report` is `{kind, state, version, parent, retained}`, `target`
 * `{id, state, version}` or null. The upholding needs the grant to remove the target; while the
 * target is approved the same decision removes it with `upheld-report`, otherwise only the report
 * changes.
 */
export function planUphold(report, target, request) {
  const role = request?.role;
  if (!(role === "site-admin" || role === "coordinator")) return refuse("denied");
  if (report?.kind !== "abuse-report" || !MODERATION_STATES.includes(report.state)) return refuse("notAllowed");
  if (request.expectedVersion !== report.version) return refuse("stale");
  if (report.state !== "pending") return refuse("notAllowed");
  const reason = request.reason === undefined || request.reason === null || request.reason === "" ? null : request.reason;
  if (reason === null) return refuse("reasonRequired");
  if (!UPHOLD.includes(reason)) return refuse("reasonNotAllowed");
  if (report.retained === false) return refuse("contentPurged");
  if (!target || target.id !== report.parent) return refuse("reportMismatch");
  return {
    ok: true,
    change: { action: "uphold-report", from: "pending", to: "approved", reason, version: report.version + 1 },
    removal: target.state === "approved" ? { action: "remove", from: "approved", to: "removed", reason: "upheld-report", version: target.version + 1 } : null,
  };
}
