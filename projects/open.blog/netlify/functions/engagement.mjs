import { captchaSettings, checkPass, issuePass, verifyCaptcha } from "../lib/comment-captcha.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FEEDBACK_KINDS, canonicalTime, readFeedbackSubmissionJson, readSubmissionJson, receiveFeedback } from "../../web/components/passage-feedback.js";
import { AUTHOR_RESPONSE_KIND, PARENT_UNAVAILABLE, checkAnswerParent, mayDecideResponse, parentFactsOfRow, readAuthorResponseRequest, receiveAuthorResponse } from "../lib/author-response.mjs";
import { EVIDENCE_KINDS, decisionsOf, emptyLog, planDecision } from "../lib/correction-decisions.mjs";
import { FUTURE_SUGGESTION_KIND, holdsIdentity, planConversion, planCredit, readClarification, readConversions, readerStanding, readSuggestionSubmissionJson, receiveSuggestion, scrubbedIdentity, suggestionCredit } from "../../web/components/future-suggestion.js";
import { isWorkPath } from "../../web/components/passage-feedback.js";
import { MODERATION_STATES, auditActor, planModeration } from "../lib/feedback-moderation.mjs";
import {
  INBOX_ACTIONS, MODERATOR_ROLES, PARTICIPATION_KINDS, REPORT_GROUNDS, commentState, commentStateFilter, isPublishable, issuesReceipts, legacyCommentStatus,
  legacySupports, planErasure, planTransition, planUphold, retentionStep, timeKey,
} from "../lib/participation-moderation.mjs";
import {
  THIRD_PERSPECTIVE_KIND, checkThirdPerspectiveApproval, normalizeReflection, readThirdPerspectiveSubmissionJson, receiveThirdPerspective,
  consentInEffect, reviseClarificationConsent, reviseConsent, submissionKind,
} from "../../web/components/third-perspective.js";

const json = (statusCode, value, origin = "") => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  },
  body: JSON.stringify(value),
});

const safeEqual = (left, right) => {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

const cleanPath = (value) => {
  const path = String(value || "").trim();
  if (path.length < 2 || path.length > 500 || !path.startsWith("/") || path.startsWith("//") || !path.endsWith("/") || /[\\?#\u0000-\u001F]/.test(path)) return "";
  return path.split("/").some((segment) => segment === "." || segment === "..") ? "" : path;
};

const publicComment = (row) => ({
  id: row.id,
  authorName: row.author_name,
  body: row.body,
  createdAt: row.created_at,
  ...(row.status ? { status: row.status } : {}),
});

// A stored feedback row as the moderation item Admin reads (ADRs 0081 and
// 0083): the ADR 0079 record with its provenance, plus the row id, its
// moderation state, the version every change must name, and the last reason.
// This is B5's /admin/feedback shape, kept exactly as v0.33.0 sent it so an
// older Admin, which refuses unknown fields, still reads every item; only the
// inbox's items add the facts the state machine decides on (ADR 0106). The
// reader's name is shown to moderators only, with their publication choice;
// Admin decides who among them may see it (ADR 0103).
const moderationFacts = (row) => (row.item_revision === undefined ? {} : {
  itemRevision: row.item_revision,
  approvedRevision: row.approved_revision ?? null,
  clarificationAsked: row.clarification_asked ?? null,
  clarificationConsent: row.clarification_consent === true,
  // Only a Third Perspective's approval binds a consent record (ADR 0113), and only items of that
  // kind carry the field, so an older Admin still reads every other item.
  ...(row.kind === THIRD_PERSPECTIVE_KIND && row.approved_consent !== undefined ? { approvedConsent: row.approved_consent ?? null } : {}),
});
const hostedFeedback = (row) => {
  const provenance = { version: 1, work: row.work, revision: row.revision, target: row.target };
  const seenAt = row.seen_at ? canonicalTime(row.seen_at) : null;
  if (seenAt) provenance.seenAt = seenAt;
  provenance.receivedAt = canonicalTime(row.received_at);
  provenance.channel = row.channel;
  provenance.attribution = row.reader_name ? { name: row.reader_name, publishName: row.publish_name === true } : { publishName: false };
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    moderatedAt: row.moderated_at ? canonicalTime(row.moderated_at) : null,
    reason: row.moderation_reason ?? null,
    feedback: {
      // A version 2 row read without its evidence column (the opt-in is off, as after the
      // rollback) is the plain version 1 record it also is: nothing is lost, and it can still be
      // moderated, erased and retained.
      version: row.format_version === 2 && !row.evidence ? 1 : row.format_version,
      kind: row.kind,
      body: row.body,
      details: row.details || {},
      provenance,
      // An evidence submission's block (ADR 0116), read only where the schema has it.
      ...(row.evidence ? { evidence: row.evidence } : {}),
    },
  };
};

const FEEDBACK_COLUMNS = "id,status,version,moderated_at,moderation_reason,format_version,kind,work,revision,target,body,details,seen_at,received_at,channel,reader_name,publish_name";
// What supabase/feedback.sql adds for the moderation inbox (ADR 0106).
const FEEDBACK_INBOX_COLUMNS = `${FEEDBACK_COLUMNS},item_revision,approved_revision,clarification_asked,clarification_consent`;
const COMMENT_COLUMNS = "id,path,author_name,body,status,created_at,moderated_at";
// What supabase/moderation.sql adds to comments (ADR 0106).
const COMMENT_INBOX_COLUMNS = `${COMMENT_COLUMNS},version,moderation_state,moderation_reason`;
// What engagement protection adds (ADR 0108). The receipt_hash column is never read back out;
// a Third Perspective's details carry the same digest (ADR 0113) so Admin can check the copy it
// reads back, and no reader or moderator view shows it.
const FEEDBACK_PROTECTED_COLUMNS = `${FEEDBACK_INBOX_COLUMNS},purged_at`;
// What evidence and correction decisions add (ADRs 0116 and 0117): the reader's evidence block and
// the author's decision log.
const EVIDENCE_COLUMN = ",evidence";
const DECISIONS_COLUMN = ",decisions";
// What Third Perspectives add (ADR 0113): the consent record an approval covers.
const FEEDBACK_PERSPECTIVE_COLUMNS = `${FEEDBACK_PROTECTED_COLUMNS},approved_consent`;
const COMMENT_PROTECTED_COLUMNS = `${COMMENT_INBOX_COLUMNS},purged_at`;
const REPORT_COLUMNS = "id,target_source,target_id,work,ground,body,status,version,received_at,moderated_at,moderation_reason,purged_at";

// An item whose text, details and name were purged (ADR 0104): its facts only.
const purgedItem = (source, row) => ({
  source,
  id: row.id,
  kind: source === "comment" ? "comment" : source === "report" ? "abuse-report" : row.kind,
  status: source === "comment" ? commentState(row.moderation_state, row.status) : row.status,
  version: row.version ?? 1,
  revision: source === "feedback" ? row.item_revision ?? 1 : 1,
  moderatedAt: row.moderated_at ? canonicalTime(row.moderated_at) : null,
  reason: row.moderation_reason ?? null,
  receivedAt: canonicalTime(source === "comment" ? row.created_at : row.received_at),
  work: source === "comment" ? row.path : row.work,
  purgedAt: canonicalTime(row.purged_at),
});

// The item an abuse report names, as moderators see it with the report: never a feedback reader's
// name, and no text once it was purged.
const reportedTarget = (source, row) => {
  if (!row) return null;
  const purged = Boolean(row.purged_at);
  if (source === "comment") {
    return {
      source, id: row.id, kind: "comment", status: commentState(row.moderation_state, row.status), version: row.version ?? 1, revision: 1,
      authorName: purged ? null : row.author_name, body: purged ? null : row.body,
    };
  }
  return { source, id: row.id, kind: row.kind, status: row.status, version: row.version, revision: row.item_revision ?? 1, body: purged ? null : row.body };
};

// A comment row as an inbox item (ADR 0105). Without the inbox's schema a
// comment has only its three statuses and is always at version 1; with it,
// its full state, unless a write made without the schema has since changed
// its status (ADR 0106).
const inboxComment = (row) => ({
  source: "comment",
  id: row.id,
  status: commentState(row.moderation_state, row.status),
  version: row.version ?? 1,
  moderatedAt: row.moderated_at ? canonicalTime(row.moderated_at) : null,
  reason: row.moderation_reason ?? null,
  comment: { path: row.path, authorName: row.author_name, body: row.body, createdAt: canonicalTime(row.created_at) },
});
// An inbox item carries its decision log where the schema keeps one, an empty one for an item
// nobody decided, so Admin knows the hosted service can store a decision (ADR 0117). Only an
// evidence submission takes decisions: every other kind reads back without the field, as Admin
// refuses an item of another kind that carries one.
const decisionFacts = (row) => (Object.hasOwn(row, "decisions") && EVIDENCE_KINDS.includes(row.kind) ? { decisions: row.decisions ?? emptyLog(row.id) } : {});
const inboxFeedback = (row) => ({ source: "feedback", ...hostedFeedback(row), ...moderationFacts(row), ...decisionFacts(row) });
const inboxReport = (row, targets) => ({
  source: "report",
  id: row.id,
  status: row.status,
  version: row.version,
  moderatedAt: row.moderated_at ? canonicalTime(row.moderated_at) : null,
  reason: row.moderation_reason ?? null,
  receivedAt: canonicalTime(row.received_at),
  work: row.work,
  report: { ground: row.ground, body: row.body ?? null },
  target: reportedTarget(row.target_source, targets?.get(`${row.target_source}:${String(row.target_id).toLowerCase()}`)),
});
const inboxItem = (source, row, targets) => {
  if (row.purged_at) return purgedItem(source, row);
  if (source === "comment") return inboxComment(row);
  if (source === "report") return inboxReport(row, targets);
  return inboxFeedback(row);
};

// A Third Perspective's details hold the reader's consent records and their receipt's digest; the
// reader sees only the prompt category they chose, and whether they may be asked, as `consent`.
const receiptDetails = (row) => {
  const details = row.details || {};
  // The links an author recorded name their account and their own drafts, series and sources: the
  // reader sees none of them, only the standing the receipt derives from them (ADR 0163).
  if (row.kind === FUTURE_SUGGESTION_KIND) {
    const { conversions, creditRevision, ...own } = details;
    return own;
  }
  if (row.kind !== THIRD_PERSPECTIVE_KIND) return details;
  return typeof details.category === "string" ? { category: details.category } : {};
};
// Whether an approved Third Perspective may be public now (ADR 0111): approved at its current text,
// not waiting on a clarification of that text, under an approved consent record that agreed to
// publication while the consent in effect still does. Only then can the canonical page show it.
// With the consent column unread (Third Perspectives switched off or rolled back) the answer is
// unknown, null, and a caller falls back on plain approval at the current text.
const perspectivePublic = (row) => {
  const revision = row.item_revision ?? 1;
  if (row.status !== "approved" || row.approved_revision !== revision || row.clarification_asked === revision) return false;
  if (!("approved_consent" in row)) return null;
  const consents = Array.isArray(row.details?.consents) ? row.details.consents : [];
  const approved = consents.find((record) => record && record.number === row.approved_consent);
  return approved?.publish === true && consents.at(-1)?.publish === true;
};
// What a reader sees of their own note by its receipt (ADR 0107): its kind,
// state and version, their own words until they are purged, whether the
// author asked them to clarify it and why, and whether they agreed to be
// asked. Never anything about a moderator.
// What a reader may do about featuring their reflection (ADR 0176, 0177): the revision they see (the
// approved one once approved, else the current one), whether their agreement covers exactly it, and
// whether it covers only an earlier text. null where there is nothing to agree to: not a kept
// reflection in a state that can still be shown, or consent revoked.
const featureConsentView = (row) => {
  if (row.purged_at || !["pending", "clarification", "approved"].includes(row.status)) return null;
  const revision = row.status === "approved" ? row.approved_revision ?? null : row.item_revision ?? 1;
  const last = consentInEffect(row.details);
  if (revision === null || !last?.publish) return null;
  const agreedFor = Number.isInteger(last.featureRevision) ? last.featureRevision : null;
  return { revision, agreed: agreedFor === revision, earlier: agreedFor !== null && agreedFor !== revision };
};
const receiptViewOf = (row, hidden = false) => {
  const purged = Boolean(row.purged_at);
  const revision = row.item_revision ?? 1;
  const asked = row.status === "clarification" && row.clarification_asked === revision;
  return {
    kind: row.kind,
    status: row.status,
    version: row.version,
    work: row.work,
    receivedAt: canonicalTime(row.received_at),
    clarification: asked ? { reason: row.moderation_reason ?? null } : null,
    consent: row.clarification_consent === true,
    // A Third Perspective is published only while its consent still allows it and its kind is not
    // hidden (ADR 0115). Without the consent column that is unknown, null, never "not shown". A kind
    // that is never public (an approved suggestion for future work is only in the editors' queue)
    // is never published, whatever its state.
    published: !isPublishable(row.kind) ? false : row.kind === THIRD_PERSPECTIVE_KIND ? (hidden ? false : perspectivePublic(row)) : row.status === "approved" && row.approved_revision === revision,
    purged,
    ...(row.kind === THIRD_PERSPECTIVE_KIND && !purged ? { feature: featureConsentView(row) } : {}),
    ...(purged ? {} : { body: row.body, details: receiptDetails(row) }),
    // Where a suggestion stands, honestly and in the words of ACCEPTANCE_NOTICE: a stage and one
    // sentence, never a rank, a count, a promise or what it was linked to (ADR 0163).
    ...(row.kind === FUTURE_SUGGESTION_KIND && !purged ? { standing: readerStanding(row.status, readConversions(row.details) ?? []) } : {}),
    // Whether a reader who gave a name has agreed to be credited by it for this text as it stands
    // (ADR 0167); null when they gave none, so there is nothing to agree to.
    ...(row.kind === FUTURE_SUGGESTION_KIND && !purged ? { credit: row.reader_name ? { agreed: suggestionCredit(row) !== null } : null } : {}),
  };
};

// The inbox's keyset cursor (timeKey): a row's own time, to the microsecond,
// in UTC, and its id. Rows of every store are merged in this order.
const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const INBOX_PAGE = 50;
const INBOX_UNAVAILABLE = "Run supabase/moderation.sql (and supabase/feedback.sql again if you use passage feedback), then set OPENBLOG_MODERATION_ENABLED=true, to take this decision.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_UNAVAILABLE = "Passage feedback is not available on this site. The page itself is unchanged; you can copy your note and send it to the author instead.";
const PERSPECTIVE_UNAVAILABLE = "This site does not take Third Perspectives through the form. The page itself is unchanged; you can copy your reflection and send it to the author instead.";
const SUGGESTION_UNAVAILABLE = "This site does not take suggestions through the form. The page itself is unchanged; you can copy your suggestion and send it to the author instead.";
const PERSPECTIVE_INBOX_UNAVAILABLE = "Run supabase/feedback.sql again and set OPENBLOG_THIRD_PERSPECTIVES_ENABLED=true to approve Third Perspectives, so each approval records the consent it covers.";
// Author responses (ADR 0132) need no SQL: they are rows of the Third Perspectives' table. Only this opt-in.
const ANSWER_UNAVAILABLE = "Set OPENBLOG_AUTHOR_RESPONSES_ENABLED=true, on top of Third Perspectives, for authors to answer them.";
const ANSWER_PARENT_UNAVAILABLE = "The reflection this answers is not shown to readers now, so it cannot be answered or its answer approved.";
// Which parent mismatches are the request's fault (422) and which are the world having moved (409).
const ANSWER_PARENT_MISMATCHES = { notAttributed: "That reflection is not about one author's section.", responderMismatch: "That reflection is about another author's section.", wrongWork: "That reflection is about another work." };
// Engagement protection (ADRs 0107 and 0108).
const PROTECTION_UNAVAILABLE = "This site does not offer receipts or reports through the form. You can write to the author instead.";
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const receiptDigest = (receipt) => createHash("sha256").update(receipt).digest("hex");
const RECEIPT_UNKNOWN = "No note matches this receipt. Check that you copied all of it.";
// The audit trail's names for a reader acting by receipt and for the retention job.
const READER_ACTOR = "@reader";
const RETENTION_ACTOR = "@retention";
const MAX_REPORT_CHARS = 1000;
const RETENTION_BATCH = 200;
const DAY_MS = 86_400_000;

export function createHandler({ env = process.env, fetchImpl = fetch, siteFetchImpl = fetchImpl, now = () => new Date() } = {}) {
  const configured = () => {
    const values = {
      url: String(env.SUPABASE_URL || "").replace(/\/$/, ""),
      key: String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || ""),
      siteId: String(env.OPENBLOG_SITE_ID || "").trim(),
      origin: String(env.OPENBLOG_SITE_ORIGIN || "").replace(/\/$/, ""),
      adminKey: String(env.OPENBLOG_ADMIN_API_KEY || ""),
      salt: String(env.OPENBLOG_ANALYTICS_SALT || ""),
      basePath: String(env.OPENBLOG_SITE_BASE_PATH || "/").trim(),
      // Typed passage feedback is off unless the deployer ran
      // supabase/feedback.sql and set this explicitly (ADR 0081).
      feedback: String(env.OPENBLOG_FEEDBACK_ENABLED || "").trim() === "true",
      // The moderation inbox's full schema (ADR 0106): set only after
      // running supabase/moderation.sql, and feedback.sql again if feedback
      // is on. Without it the inbox stores what the older schema can.
      moderation: String(env.OPENBLOG_MODERATION_ENABLED || "").trim() === "true",
    };
    // Receipts, abuse reports, deletion and retention (ADR 0108): set only
    // after running supabase/protection.sql, on top of the inbox's schema.
    values.protection = values.moderation && String(env.OPENBLOG_PROTECTION_ENABLED || "").trim() === "true";
    // Evidence submissions and correction decisions (ADRs 0116 and 0117):
    // set only after running supabase/feedback.sql again, on top of the
    // inbox's schema. Without it version 2 submissions are refused, as B5
    // refuses them, and no decision can be stored.
    values.corrections = values.feedback && values.moderation && String(env.OPENBLOG_CORRECTIONS_ENABLED || "").trim() === "true";
    // Third Perspectives (ADR 0113): set only after running supabase/feedback.sql again, on top of
    // passage feedback and protection, because every hosted copy needs its reader's receipt.
    values.thirdPerspectives = values.protection && values.feedback && String(env.OPENBLOG_THIRD_PERSPECTIVES_ENABLED || "").trim() === "true";
    // Author responses (ADR 0132): the same store and inbox, opt in on top of Third Perspectives.
    values.authorResponses = values.thirdPerspectives && String(env.OPENBLOG_AUTHOR_RESPONSES_ENABLED || "").trim() === "true";
    // Suggestions for future work (ADR 0154): set only after running supabase/feedback.sql again,
    // which loosens the one check that kept a row about a page from having no passage, on top of
    // passage feedback and protection, because every hosted suggestion needs its reader's receipt.
    values.suggestions = values.protection && values.feedback && String(env.OPENBLOG_SUGGESTIONS_ENABLED || "").trim() === "true";
    const required = [values.url, values.key, values.siteId, values.origin, values.adminKey, values.salt];
    if (!required.every(Boolean) || !/^\/(?:[^\\?#\u0000-\u001F]*\/)?$/.test(values.basePath) || values.basePath.includes("//") || values.basePath.split("/").some((segment) => segment === "." || segment === "..")) return null;
    return values;
  };

  const database = async (settings, path, options = {}) => {
    const response = await fetchImpl(`${settings.url}${path}`, {
      ...options,
      headers: {
        apikey: settings.key,
        ...(!settings.key.startsWith("sb_secret_") ? { Authorization: `Bearer ${settings.key}` } : {}),
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
    return value;
  };

  // One of the deployed site's generated manifests, or null when it is not
  // published (`missing`) or cannot be read.
  const MODES = ["open", "locked", "hidden"];
  const siteManifest = async (settings, manifest) => {
    const target = new URL(`${settings.basePath}${manifest}`, `${settings.origin}/`);
    if (target.origin !== new URL(settings.origin).origin) return { value: null };
    const response = await siteFetchImpl(target.href, {
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) return { value: null, missing: response.status === 404 };
    const value = await response.json();
    return { value: value && typeof value === "object" && !Array.isArray(value) ? value : null };
  };
  // The policy the deployed site publishes for one post, from a path-to-mode
  // manifest; anything missing or unexpected is "hidden".
  const publishedPolicy = async (settings, manifest, path) => {
    const { value } = await siteManifest(settings, manifest);
    const policy = value && Object.hasOwn(value, path) ? value[path] : "";
    return MODES.includes(policy) ? policy : "hidden";
  };
  const feedbackRows = (settings, filters) => {
    // B5's shape carries an evidence submission's block inside its record, never the decision log,
    // so an older Admin still reads every item it can.
    const select = `${FEEDBACK_COLUMNS}${settings.corrections ? EVIDENCE_COLUMN : ""}`;
    const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, ...filters, select, order: "received_at.asc", limit: "200" });
    return database(settings, `/rest/v1/openblog_feedback?${params}`);
  };

  // ---- The moderation inbox (ADRs 0105 and 0106)

  const inboxTable = (source) => (source === "comment" ? "openblog_comments" : source === "report" ? "openblog_abuse_reports" : "openblog_feedback");
  const inboxColumns = (settings, source) => {
    if (source === "report") return REPORT_COLUMNS;
    if (source === "comment") return settings.protection ? COMMENT_PROTECTED_COLUMNS : settings.moderation ? COMMENT_INBOX_COLUMNS : COMMENT_COLUMNS;
    const corrections = settings.corrections ? `${EVIDENCE_COLUMN}${DECISIONS_COLUMN}` : "";
    const base = settings.thirdPerspectives ? FEEDBACK_PERSPECTIVE_COLUMNS : settings.protection ? FEEDBACK_PROTECTED_COLUMNS : settings.moderation ? FEEDBACK_INBOX_COLUMNS : FEEDBACK_COLUMNS;
    return `${base}${corrections}`;
  };
  const rowTimeColumn = (source) => (source === "comment" ? "created_at" : "received_at");
  // The items abuse reports name, read with them so a moderator sees what was reported.
  const reportTargets = async (settings, reportRows) => {
    const targets = new Map();
    for (const source of ["comment", "feedback"]) {
      if (source === "feedback" && !settings.feedback) continue;
      const ids = [...new Set(reportRows.filter((row) => row.target_source === source).map((row) => String(row.target_id).toLowerCase()).filter((id) => UUID.test(id)))];
      if (!ids.length) continue;
      const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, id: `in.(${ids.join(",")})`, select: inboxColumns(settings, source) });
      const rows = await database(settings, `/rest/v1/${inboxTable(source)}?${params}`);
      for (const row of Array.isArray(rows) ? rows : []) targets.set(`${source}:${String(row.id).toLowerCase()}`, row);
    }
    return targets;
  };
  // A retention run's cutoffs as Admin sent them (ADR 0108): canonical UTC
  // times, each at least a day before this function's own clock, so no run
  // can reach anything newer whatever it is sent, and an audit cutoff no
  // later than the closed-item cutoff, since audit events are kept at least
  // as long as closed items (ADR 0104); null when any is not.
  const UTC_SECOND = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
  const retentionCutoffs = (input) => {
    const latest = now().getTime() - DAY_MS;
    const cutoffs = { comments: input?.comments === true || input?.comments === "true" };
    const times = {};
    for (const key of ["pendingUntil", "clarificationUntil", "closedUntil", "auditUntil"]) {
      const value = input?.[key];
      const time = typeof value === "string" && UTC_SECOND.test(value) ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(time) || time > latest) return null;
      cutoffs[key] = value;
      times[key] = time;
    }
    return times.auditUntil > times.closedUntil ? null : cutoffs;
  };
  // One store's rows a run may owe a step, oldest first, at most a batch;
  // retentionStep then decides each exactly.
  const retentionCandidates = async (settings, source, cutoffs) => {
    const time = rowTimeColumn(source);
    const since = (until) => `or(moderated_at.lte."${until}",and(moderated_at.is.null,${time}.lte."${until}"))`;
    const branches = {
      comment: [
        `and(status.eq.pending,${since(cutoffs.pendingUntil)})`,
        `and(status.eq.rejected,purged_at.is.null,${since(cutoffs.closedUntil)})`,
      ],
      feedback: [
        `and(status.eq.pending,${since(cutoffs.pendingUntil)})`,
        `and(status.eq.clarification,${since(cutoffs.clarificationUntil)})`,
        `and(status.in.(rejected,removed),purged_at.is.null,${since(cutoffs.closedUntil)})`,
        "and(status.eq.withdrawn,purged_at.is.null)",
        // An approved suggestion is kept, but its private contact and unpublished name are not
        // (ADR 0155): only one that holds some is a candidate, or the batch could fill with
        // suggestions already cleared.
        // One an author linked to future work owes it at once, whatever its age (ADR 0163).
        `and(status.eq.approved,kind.eq.${FUTURE_SUGGESTION_KIND},purged_at.is.null,or(${since(cutoffs.closedUntil)},details->conversions.not.is.null),or(details->contact.not.is.null,and(reader_name.not.is.null,publish_name.eq.false)))`,
      ],
      report: [
        `and(status.eq.pending,${since(cutoffs.pendingUntil)})`,
        `and(status.in.(rejected,approved),purged_at.is.null,${since(cutoffs.closedUntil)})`,
      ],
    }[source];
    const params = new URLSearchParams({
      site_id: `eq.${settings.siteId}`,
      or: `(${branches.join(",")})`,
      select: inboxColumns(settings, source),
      order: `${time}.asc,id.asc`,
      limit: String(RETENTION_BATCH),
    });
    const rows = await database(settings, `/rest/v1/${inboxTable(source)}?${params}`);
    return Array.isArray(rows) ? rows : [];
  };
  // Audit events recorded at or before the run's audit cutoff: counted for
  // the dry run (at most 10,001 per table), deleted when the run asks.
  const auditDue = async (settings, cutoffs, deleteNow) => {
    const tables = { comment: "openblog_comment_events", ...(settings.feedback ? { feedback: "openblog_feedback_events" } : {}), report: "openblog_abuse_report_events" };
    const counts = {};
    for (const [source, table] of Object.entries(tables)) {
      const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, at: `lte.${cutoffs.auditUntil}`, select: "id" });
      if (!deleteNow) params.set("limit", "10001");
      const rows = await database(settings, `/rest/v1/${table}?${params}`, deleteNow ? { method: "DELETE", headers: { Prefer: "return=representation" } } : {});
      counts[source] = Array.isArray(rows) ? rows.length : 0;
    }
    return counts;
  };
  const inboxItems = async (settings, entries) => {
    const reports = entries.filter((entry) => entry.source === "report").map((entry) => entry.row);
    const targets = reports.length ? await reportTargets(settings, reports) : null;
    // A function's answer returns the whole row: without OPENBLOG_CORRECTIONS_ENABLED its decision
    // log is not offered, so Admin never offers a decision this function would refuse to store.
    const shown = (row) => {
      if (settings.corrections || !Object.hasOwn(row, "decisions")) return row;
      const { decisions, ...rest } = row;
      return rest;
    };
    return entries.map((entry) => inboxItem(entry.source, shown(entry.row), targets));
  };

  // One store's rows in one state after a cursor, oldest first, at most
  // `limit`. Comments never wait for clarification or are withdrawn, and
  // without the inbox's schema they are only pending, approved or rejected.
  const inboxRows = async (settings, source, { state, kind, after, limit }) => {
    const time = rowTimeColumn(source);
    const conditions = [];
    if (source === "comment") {
      const filter = settings.moderation ? commentStateFilter(state) : null;
      if (filter) conditions.push(filter);
      else if (!settings.moderation && ["pending", "approved", "rejected"].includes(state)) conditions.push(`status.eq.${state}`);
      else return [];
    } else if (source === "report") {
      // Reports are pending, dismissed (rejected) or upheld (approved).
      if (!["pending", "approved", "rejected"].includes(state)) return [];
      conditions.push(`status.eq.${state}`);
    } else {
      conditions.push(`status.eq.${state}`);
      if (kind) conditions.push(`kind.eq.${kind}`);
    }
    if (after) conditions.push(`or(${time}.gt."${after.time}",and(${time}.eq."${after.time}",id.gt.${after.id}))`);
    const params = new URLSearchParams({
      site_id: `eq.${settings.siteId}`,
      and: `(${conditions.join(",")})`,
      select: inboxColumns(settings, source),
      order: `${time}.asc,id.asc`,
      limit: String(limit),
    });
    const rows = await database(settings, `/rest/v1/${inboxTable(source)}?${params}`);
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({ source, row, key: timeKey(row[time]), id: String(row.id).toLowerCase() }))
      .filter((entry) => entry.key);
  };
  const inboxRow = async (settings, source, id) => {
    const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, id: `eq.${id}`, select: inboxColumns(settings, source) });
    const rows = await database(settings, `/rest/v1/${inboxTable(source)}?${params}`);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  };
  // The facts the state machine decides on, from a stored row.
  const inboxFacts = (source, row) => {
    const retained = !row.purged_at;
    return {
      kind: source === "comment" ? "comment" : source === "report" ? "abuse-report" : row.kind,
      state: source === "comment" ? commentState(row.moderation_state, row.status) : row.status,
      version: row.version ?? 1,
      revision: source === "feedback" ? row.item_revision ?? 1 : 1,
      clarificationAsked: source === "feedback" ? row.clarification_asked ?? null : null,
      clarificationConsent: row.clarification_consent === true,
      contentRetained: retained,
      retained,
      parent: source === "report" ? String(row.target_id).toLowerCase() : null,
      since: row.moderated_at || row[rowTimeColumn(source)],
      // A kept suggestion owes retention only the clearing of what is private to it (ADR 0155).
      ...(source === "feedback" && row.kind === FUTURE_SUGGESTION_KIND ? { identityHeld: holdsIdentity(row), linked: (readConversions(row.details) ?? []).length > 0 } : {}),
    };
  };
  // Apply one planned change, only while the row still has the state and
  // version both Admin and this function saw, with its audit event.
  const applyInboxChange = (settings, source, id, change, version, actor, role) => {
    const at = canonicalTime(now());
    if (settings.moderation) {
      const functionName = { comment: "openblog_moderate_comment", feedback: "openblog_moderate_feedback_item", report: "openblog_moderate_report" }[source];
      return database(settings, `/rest/v1/rpc/${functionName}`, {
        method: "POST",
        body: JSON.stringify({
          p_site_id: settings.siteId, p_id: id, p_expected_version: version, p_from: change.from, p_to: change.to,
          p_action: change.action, p_reason: change.reason, p_actor: actor, p_actor_role: role, p_at: at,
        }),
      });
    }
    if (source === "feedback") {
      return database(settings, "/rest/v1/rpc/openblog_moderate_feedback", {
        method: "POST",
        body: JSON.stringify({
          p_site_id: settings.siteId, p_id: id, p_expected_version: version, p_from: change.from, p_to: change.to,
          p_action: change.action, p_reason: change.reason, p_actor: actor, p_at: at,
        }),
      });
    }
    // An older comment table has no version: the change applies only while
    // the row still has the status it was read with.
    const params = new URLSearchParams({ id: `eq.${id}`, site_id: `eq.${settings.siteId}`, status: `eq.${legacyCommentStatus(change.from)}`, select: COMMENT_COLUMNS });
    return database(settings, `/rest/v1/openblog_comments?${params}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: legacyCommentStatus(change.to), moderated_at: at }),
    });
  };
  // One inbox decision on a Third Perspective (ADR 0113), through its own function, which also
  // records the consent record an approval covers and refuses one whose consent changed.
  const applyPerspectiveChange = (settings, id, change, version, actor, role, consent) => database(settings, "/rest/v1/rpc/openblog_moderate_third_perspective", {
    method: "POST",
    body: JSON.stringify({
      p_site_id: settings.siteId, p_id: id, p_expected_version: version, p_from: change.from, p_to: change.to,
      p_action: change.action, p_reason: change.reason, p_actor: actor, p_actor_role: role, p_at: canonicalTime(now()),
      p_consent: change.to === "approved" ? consent : null,
    }),
  });
  const commentPolicy = (settings, path) => publishedPolicy(settings, "openblog-comments.json", path);
  // One passage feedback kind's mode on one post (ADR 0101), from the
  // participation manifest; a missing post or kind is "hidden". A site built
  // before that manifest existed still publishes B5's openblog-feedback.json,
  // which is read only when the participation manifest is not published,
  // and only for B5's four passage kinds: every other kind, abuse reports
  // among them, is hidden on a site that never published its mode.
  const feedbackPolicy = async (settings, path, kind) => {
    const { value, missing } = await siteManifest(settings, "openblog-participation.json");
    if (missing) return Object.hasOwn(FEEDBACK_KINDS, kind) ? publishedPolicy(settings, "openblog-feedback.json", path) : "hidden";
    const modes = value && Object.hasOwn(value, path) ? value[path] : null;
    const mode = modes && typeof modes === "object" && Object.hasOwn(modes, kind) ? modes[kind] : "";
    return MODES.includes(mode) ? mode : "hidden";
  };

  // The existing Supabase-backed hourly quota, per client (or per `subject`,
  // such as a reported item or a repeated submission) and per site. The
  // stored digest mixes in the hour, so no row links one hour's requests to
  // another's, and the address itself is never stored (ADR 0108).
  const quotaWindow = (settings, bucket, subject) => {
    const hour = now().toISOString().slice(0, 13) + ":00:00Z";
    return { bucket, hour, digest: createHash("sha256").update(`${settings.salt}\0${bucket}\0${hour}\0${subject}`).digest("hex") };
  };
  const consumeWindow = async (settings, { bucket, hour, digest }, subjectLimit, siteLimit) => {
    const allowed = await database(settings, "/rest/v1/rpc/openblog_consume_rate_limit", {
      method: "POST",
      body: JSON.stringify({ p_site_id: settings.siteId, p_bucket: bucket, p_window_start: hour, p_subject_hash: digest, p_subject_limit: subjectLimit, p_site_limit: siteLimit }),
    });
    return Boolean(allowed?.allowed ?? allowed);
  };
  const consumeQuota = (settings, event, bucket, subjectLimit, siteLimit, subject = null) => {
    const address = String(event.headers?.["x-nf-client-connection-ip"] || "").trim();
    return consumeWindow(settings, quotaWindow(settings, bucket, subject ?? address), subjectLimit, siteLimit);
  };
  // A replay bound (ADR 0108): the same submission from the same client is
  // taken once an hour. Only a digest of it is kept, for the hour. It
  // answers null when the submission was already taken this hour, or else
  // the claim on it, which `storedOnce` releases when storing the submission
  // fails, so a reader who retries is never told it was already sent.
  const firstTimeThisHour = async (settings, event, bucket, parts) => {
    const address = String(event.headers?.["x-nf-client-connection-ip"] || "").trim();
    const window = quotaWindow(settings, `${bucket}-repeat`, [address, ...parts].join("\0"));
    return await consumeWindow(settings, window, 1, 1_000_000) ? window : null;
  };
  const storedOnce = async (settings, claim, store) => {
    try {
      return await store();
    } catch (error) {
      if (claim) {
        const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, bucket: `eq.${claim.bucket}`, window_start: `eq.${claim.hour}`, subject_hash: `eq.${claim.digest}` });
        await database(settings, `/rest/v1/openblog_rate_limits?${params}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);
      }
      throw error;
    }
  };

  // The stored Third Perspective an answer sits under, and the code of the first reason it does not
  // belong there now (null when it does), read from the stored rows and never from the request.
  const answerParentCode = async (settings, work, parentId, contributor) => {
    if (!UUID.test(String(parentId || ""))) return { code: PARENT_UNAVAILABLE, parent: null };
    const parent = await inboxRow(settings, "feedback", String(parentId).toLowerCase());
    if (!parent || parent.kind !== THIRD_PERSPECTIVE_KIND) return { code: PARENT_UNAVAILABLE, parent };
    if (await feedbackPolicy(settings, parent.work, THIRD_PERSPECTIVE_KIND) === "hidden") return { code: PARENT_UNAVAILABLE, parent };
    return { code: checkAnswerParent(parentFactsOfRow(parent), work, contributor), parent };
  };
  const answerParentRefusal = (code, origin, current = null) => (code === PARENT_UNAVAILABLE
    ? json(409, { error: ANSWER_PARENT_UNAVAILABLE, code, ...(current ? { item: current } : {}) }, origin)
    : json(422, { error: ANSWER_PARENT_MISMATCHES[code] || ANSWER_PARENT_UNAVAILABLE, code }, origin));

  return async (event) => {
    const settings = configured();
    if (!settings) return json(503, { error: "Hosted engagement is not configured." });
    const requestOrigin = String(event.headers?.origin || "").replace(/\/$/, "");
    const corsOrigin = requestOrigin === settings.origin ? requestOrigin : "";
    if (event.httpMethod === "OPTIONS") {
      if (!corsOrigin) return json(403, { error: "Origin is not allowed." });
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
          Vary: "Origin",
        },
        body: "",
      };
    }
    const segments = event.path.split("/").filter(Boolean);
    const leaf = segments.at(-1) || "";
    const operation = segments.at(-2) === "admin" ? `admin/${leaf}` : leaf;
    const mutating = event.httpMethod === "POST" || event.httpMethod === "PATCH";
    const token = String(event.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    const admin = safeEqual(token, settings.adminKey);
    if (mutating && !corsOrigin && !admin) return json(403, { error: "Origin is not allowed." });
    const query = event.queryStringParameters || {};
    let body = {};
    // A feedback submission is read from its exact text, so the shared
    // validator can check how its numbers are written (ADR 0079).
    const rawFeedback = operation === "feedback" && event.httpMethod === "POST";
    if (mutating && !rawFeedback) {
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "Invalid JSON." }, corsOrigin);
      }
    }
    try {
      if (operation === "comments" && event.httpMethod === "GET") {
        const path = cleanPath(query.path);
        if (!path) return json(400, { error: "Invalid post path." }, corsOrigin);
        if (await commentPolicy(settings, path) === "hidden") {
          return json(200, { comments: [] }, corsOrigin);
        }
        const params = new URLSearchParams({
          site_id: `eq.${settings.siteId}`,
          path: `eq.${path}`,
          status: "eq.approved",
          select: "id,author_name,body,created_at",
          order: "created_at.asc",
          limit: "200",
        });
        const rows = await database(settings, `/rest/v1/openblog_comments?${params}`);
        return json(200, { comments: rows.map(publicComment) }, corsOrigin);
      }
      if (operation === "comments" && event.httpMethod === "POST") {
        const path = cleanPath(body.path);
        const authorName = String(body.authorName || "").trim().replace(/\s+/g, " ");
        const commentBody = String(body.body || "").trim();
        if (!path || authorName.length < 1 || authorName.length > 80 || commentBody.length < 1 || commentBody.length > 4000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(commentBody)) {
          return json(422, { error: "Enter a valid name and a comment no longer than 4,000 characters." }, corsOrigin);
        }
        const policy = await commentPolicy(settings, path);
        if (policy !== "open") {
          return json(403, { error: policy === "locked" ? "This discussion is read-only." : "Comments are not available for this post." }, corsOrigin);
        }
        let captchaPass;
        const captcha = captchaSettings(env);
        if (captcha.enabled) {
          if (captcha.missing.length) {
            return json(503, { code: "captcha_unconfigured", error: `Comment verification is enabled but ${captcha.missing.join(", ")} is not set correctly. Ask the site owner to configure it.` }, corsOrigin);
          }
          const moment = now();
          const usePass = captcha.scope === "session" && typeof body.captchaPass === "string" && body.captchaPass !== "";
          const pass = usePass ? checkPass(body.captchaPass, settings.siteId, captcha.sessionSecret, moment) : null;
          if (pass?.reason === "expired") {
            return json(403, { code: "captcha_expired", error: "Your verification expired. Please verify again. Your comment has not been sent." }, corsOrigin);
          }
          if (!pass?.ok) {
            const hasToken = typeof body.captchaToken === "string" && body.captchaToken !== "";
            let failed = Boolean(pass);
            // Every verification attempt spends the captcha bucket before the provider is called, so the
            // bucket also bounds outbound verifier traffic. A request with no token and no pass is not an attempt.
            if ((hasToken || pass) && !await consumeQuota(settings, event, "captcha", 10, 1000)) {
              return json(429, { code: "captcha_rate_limited", error: "Too many verification attempts. Please wait a while and try again." }, corsOrigin);
            }
            if (hasToken) {
              const outcome = await verifyCaptcha({ provider: captcha.provider, token: body.captchaToken, secret: captcha.turnstileSecret, remoteIp: String(event.headers?.["x-nf-client-connection-ip"] || "").trim(), fetchImpl });
              failed = !outcome.ok;
              if (outcome.ok && captcha.scope === "session") captchaPass = issuePass(settings.siteId, captcha.sessionSecret, moment, captcha.ttl);
            }
            if (failed || !hasToken) {
              return json(403, { code: "captcha_required", error: "Please complete the comment verification and try again. Your comment has not been sent." }, corsOrigin);
            }
          }
        }
        if (!await consumeQuota(settings, event, "comments", 5, 500)) return json(429, { error: "Too many comments. Please try again later." }, corsOrigin);
        const claim = settings.protection ? await firstTimeThisHour(settings, event, "comments", [path, authorName, commentBody]) : null;
        if (settings.protection && !claim) {
          return json(409, { error: "This comment was already sent and is waiting for review.", code: "duplicate" }, corsOrigin);
        }
        const rows = await storedOnce(settings, claim, () => database(settings, "/rest/v1/openblog_comments?select=id,status,created_at", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ site_id: settings.siteId, path, author_name: authorName, body: commentBody, status: "pending" }),
        }));
        return json(202, { id: rows[0]?.id, status: "pending", ...(captchaPass ? { captchaPass: captchaPass.pass, captchaPassExpiresAt: captchaPass.expiresAt } : {}) }, corsOrigin);
      }
      if (operation === "feedback" || operation === "admin/feedback") {
        if (operation === "admin/feedback" && !admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        if (!settings.feedback) return json(404, { error: FEEDBACK_UNAVAILABLE, code: "unavailable" }, corsOrigin);
      }
      if (operation === "feedback" && event.httpMethod === "POST") {
        const text = event.isBase64Encoded ? Buffer.from(String(event.body || ""), "base64").toString("utf8") : String(event.body || "");
        if (submissionKind(text) === THIRD_PERSPECTIVE_KIND) {
          // A Third Perspective (ADR 0113): the same route and store, read by its own contract.
          // Every hosted copy has a receipt, so the reader can always withdraw it.
          if (!settings.thirdPerspectives) return json(404, { error: PERSPECTIVE_UNAVAILABLE, code: "unavailable" }, corsOrigin);
          const read = readThirdPerspectiveSubmissionJson(text);
          if (!read.ok) {
            const { code, message } = read.error;
            return json(code === "tooLarge" ? 413 : 422, { error: message, code }, corsOrigin);
          }
          const submission = read.submission;
          const policy = await feedbackPolicy(settings, submission.work, THIRD_PERSPECTIVE_KIND);
          if (policy !== "open") {
            return json(403, policy === "locked"
              ? { error: "This work is not taking Third Perspectives now.", code: "closed" }
              : { error: PERSPECTIVE_UNAVAILABLE, code: "unavailable" }, corsOrigin);
          }
          if (!await consumeQuota(settings, event, "feedback", 5, 500)) {
            return json(429, { error: "Too much feedback from here. Please try again later.", code: "rateLimited" }, corsOrigin);
          }
          const claim = await firstTimeThisHour(settings, event, "feedback", [submission.work, submission.kind, JSON.stringify(submission.target), submission.body]);
          if (!claim) return json(409, { error: "This reflection was already sent and is waiting for review.", code: "duplicate" }, corsOrigin);
          const receipt = randomBytes(32).toString("base64url");
          const { row } = receiveThirdPerspective(submission, canonicalTime(now()), receiptDigest(receipt));
          const rows = await storedOnce(settings, claim, () => database(settings, "/rest/v1/openblog_feedback?select=id,status,received_at", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ site_id: settings.siteId, ...row, status: "pending", receipt_hash: receiptDigest(receipt) }),
          }));
          return json(202, { id: rows[0]?.id, status: "pending", receivedAt: row.received_at, receipt }, corsOrigin);
        }
        if (submissionKind(text) === FUTURE_SUGGESTION_KIND) {
          // A suggestion for future work (ADR 0154): the same route and store, read by its own
          // contract. The page it was sent from is the request's `work`, not part of the reader's
          // submission, and must be one the site publishes with the kind open. Every hosted
          // suggestion has a receipt, so the reader can always withdraw it.
          if (!settings.suggestions) return json(404, { error: SUGGESTION_UNAVAILABLE, code: "unavailable" }, corsOrigin);
          const read = readSuggestionSubmissionJson(text);
          if (!read.ok) {
            const { code, message } = read.error;
            return json(code === "tooLarge" ? 413 : 422, { error: message, code }, corsOrigin);
          }
          const submission = read.submission;
          const work = String(query.work ?? "");
          if (!isWorkPath(work)) return json(422, { error: "Send the page you are suggesting from as `work`, such as /posts/tides/.", code: "invalidWork" }, corsOrigin);
          const policy = await feedbackPolicy(settings, work, FUTURE_SUGGESTION_KIND);
          if (policy !== "open") {
            return json(403, policy === "locked"
              ? { error: "This site is not taking suggestions now.", code: "closed" }
              : { error: SUGGESTION_UNAVAILABLE, code: "unavailable" }, corsOrigin);
          }
          if (!await consumeQuota(settings, event, "suggestions", 5, 500)) {
            return json(429, { error: "Too many suggestions from here. Please try again later.", code: "rateLimited" }, corsOrigin);
          }
          const claim = await firstTimeThisHour(settings, event, "suggestions", [work, JSON.stringify(submission)]);
          if (!claim) return json(409, { error: "This suggestion was already sent and is waiting for review.", code: "duplicate" }, corsOrigin);
          const receipt = randomBytes(32).toString("base64url");
          const { row } = receiveSuggestion(submission, work, canonicalTime(now()));
          const rows = await storedOnce(settings, claim, () => database(settings, "/rest/v1/openblog_feedback?select=id,status,received_at", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ site_id: settings.siteId, ...row, status: "pending", receipt_hash: receiptDigest(receipt) }),
          }));
          return json(202, { id: rows[0]?.id, status: "pending", receivedAt: row.received_at, receipt }, corsOrigin);
        }
        // Bounds and every rule apply before anything else, an evidence block's too (ADR 0116);
        // nothing here says whether an id the reader named exists.
        const read = readSubmissionJson(text, { evidence: settings.corrections });
        if (!read.ok) {
          const { code, message, target } = read.error;
          return json(code === "tooLarge" ? 413 : 422, { error: message, code, ...(target ? { target } : {}) }, corsOrigin);
        }
        const submission = read.submission;
        const policy = await feedbackPolicy(settings, submission.work, submission.kind);
        if (policy !== "open") {
          return json(403, policy === "locked"
            ? { error: "Feedback on this post is closed.", code: "closed" }
            : { error: FEEDBACK_UNAVAILABLE, code: "unavailable" }, corsOrigin);
        }
        if (!await consumeQuota(settings, event, "feedback", 5, 500)) {
          return json(429, { error: "Too much feedback from here. Please try again later.", code: "rateLimited" }, corsOrigin);
        }
        const claim = settings.protection ? await firstTimeThisHour(settings, event, "feedback", [submission.work, submission.kind, JSON.stringify(submission.target), submission.body, JSON.stringify(submission.evidence ?? null)]) : null;
        if (settings.protection && !claim) {
          return json(409, { error: "This note was already sent and is waiting for review.", code: "duplicate" }, corsOrigin);
        }
        // The receiver stamps the time; the reader's clock is only seenAt.
        const record = receiveFeedback(submission, canonicalTime(now()), "hosted");
        const { provenance } = record;
        // A private receipt (ADR 0107): returned to the reader once, kept
        // only as its digest.
        const receipt = settings.protection && issuesReceipts(record.kind) ? randomBytes(32).toString("base64url") : null;
        const rows = await storedOnce(settings, claim, () => database(settings, "/rest/v1/openblog_feedback?select=id,status,received_at", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            site_id: settings.siteId,
            format_version: record.version,
            kind: record.kind,
            work: provenance.work,
            revision: provenance.revision,
            target: provenance.target,
            body: record.body,
            details: record.details,
            seen_at: provenance.seenAt ?? null,
            received_at: provenance.receivedAt,
            channel: provenance.channel,
            reader_name: provenance.attribution.name ?? null,
            publish_name: provenance.attribution.publishName,
            status: "pending",
            ...(receipt ? { receipt_hash: receiptDigest(receipt) } : {}),
            ...(record.evidence ? { evidence: record.evidence } : {}),
          }),
        }));
        return json(202, { id: rows[0]?.id, status: "pending", receivedAt: provenance.receivedAt, ...(receipt ? { receipt } : {}) }, corsOrigin);
      }
      if (operation === "receipt" || operation === "reports") {
        if (!settings.protection || (operation === "receipt" && !settings.feedback)) return json(404, { error: PROTECTION_UNAVAILABLE, code: "unavailable" }, corsOrigin);
        if (event.httpMethod !== "POST") return json(405, { error: "Use POST." }, corsOrigin);
      }
      if (operation === "receipt") {
        // A reader acting on their own note by its private receipt (ADR
        // 0107): read it, answer a clarification request, agree to be asked,
        // or withdraw and delete it. The receipt is the only proof; nothing
        // identifies the reader, and nothing is e-mailed.
        const receipt = typeof body.receipt === "string" ? body.receipt : "";
        // With Third Perspectives on, the consent an approval covers decides whether one is published.
        const receiptColumns = settings.thirdPerspectives ? FEEDBACK_PERSPECTIVE_COLUMNS : FEEDBACK_PROTECTED_COLUMNS;
        if (!RECEIPT.test(receipt)) return json(404, { error: RECEIPT_UNKNOWN, code: "unknownReceipt" }, corsOrigin);
        if (!await consumeQuota(settings, event, "receipts", 30, 3000)) return json(429, { error: "Too many requests from here. Please try again later.", code: "rateLimited" }, corsOrigin);
        const lookup = async () => {
          const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, receipt_hash: `eq.${receiptDigest(receipt)}`, select: receiptColumns });
          const rows = await database(settings, `/rest/v1/openblog_feedback?${params}`);
          return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
        };
        const row = await lookup();
        if (!row) return json(404, { error: RECEIPT_UNKNOWN, code: "unknownReceipt" }, corsOrigin);
        const action = body.action ?? "read";
        const hidden = row.kind === THIRD_PERSPECTIVE_KIND && await feedbackPolicy(settings, row.work, row.kind) === "hidden";
        const receiptView = (target) => receiptViewOf(target, hidden);
        if (action === "read") return json(200, { item: receiptView(row) }, corsOrigin);
        const version = body.expectedVersion;
        if (!Number.isInteger(version) || version < 1 || version > 2147483647) return json(422, { error: "Reload your note and try again.", code: "invalid" }, corsOrigin);
        const facts = inboxFacts("feedback", row);
        const answered = (rows) => (Array.isArray(rows) && rows.length === 1
          ? json(200, { item: receiptView(rows[0]) }, corsOrigin)
          : lookup().then((current) => json(409, { error: "Your note changed since you loaded it. Review it again.", code: "conflict", item: current ? receiptView(current) : null }, corsOrigin)));
        if (version !== facts.version) return answered([]);
        if (action === "withdraw") {
          const plan = planErasure(facts, "submitter", version);
          if (!plan.ok) return json(plan.code === "stale" ? 409 : 422, { error: "This note cannot be withdrawn now.", code: plan.code, item: receiptView(row) }, corsOrigin);
          return answered(await database(settings, "/rest/v1/rpc/openblog_erase_feedback", {
            method: "POST",
            body: JSON.stringify({ p_site_id: settings.siteId, p_id: row.id, p_expected_version: version, p_withdraw: plan.withdraw, p_actor: READER_ACTOR, p_actor_role: "submitter", p_at: canonicalTime(now()) }),
          }));
        }
        if (action === "consent") {
          if (typeof body.consent !== "boolean" || facts.state !== "pending" || !facts.retained) {
            return json(422, { error: "You can change this only while your note is waiting for review.", code: "notAllowed" }, corsOrigin);
          }
          const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, id: `eq.${row.id}`, receipt_hash: `eq.${receiptDigest(receipt)}`, status: "eq.pending", version: `eq.${version}`, purged_at: "is.null", select: receiptColumns });
          if (row.kind === THIRD_PERSPECTIVE_KIND) {
            // A Third Perspective keeps every consent the reader gave as a numbered record (ADR
            // 0110): the change is appended, and the version is raised, so an approval made on
            // the earlier consent is refused instead of covering this one.
            if (!settings.thirdPerspectives) return json(404, { error: PERSPECTIVE_UNAVAILABLE, code: "unavailable" }, corsOrigin);
            const revised = reviseClarificationConsent({
              body: row.body, revision: facts.revision, provenance: hostedFeedback(row).feedback.provenance, details: row.details || {},
              state: facts.state, approvedRevision: row.approved_revision ?? null, retained: facts.retained,
            }, body.consent, canonicalTime(now()));
            if (!revised.ok) {
              if (revised.code === "unchanged") return json(200, { item: receiptView(row) }, corsOrigin);
              return json(422, { error: "Your consent cannot change again on this reflection.", code: revised.code }, corsOrigin);
            }
            return answered(await database(settings, `/rest/v1/openblog_feedback?${params}`, {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify({ details: revised.details, clarification_consent: body.consent, version: version + 1 }),
            }));
          }
          return answered(await database(settings, `/rest/v1/openblog_feedback?${params}`, {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ clarification_consent: body.consent }),
          }));
        }
        if (action === "feature") {
          // A reader's own choice about featuring their reflection (ADR 0176, 0177): agree, for the text
          // they see, or decline. Allowed while it is pending, asked to clarify or approved. The
          // change is appended as a new consent record and the version is raised, like any consent
          // change. Nothing here features anything: an editor still chooses, and a text that changes
          // leaves an agreement behind (it names a revision).
          if (row.kind !== THIRD_PERSPECTIVE_KIND || !settings.thirdPerspectives) return json(404, { error: PERSPECTIVE_UNAVAILABLE, code: "unavailable" }, corsOrigin);
          if (typeof body.consent !== "boolean" || (body.consent && !Number.isInteger(body.revisionSeen)) || !["pending", "clarification", "approved"].includes(facts.state) || !facts.retained) {
            return json(422, { error: "You can change this only while your reflection is waiting, being clarified or approved.", code: "notAllowed" }, corsOrigin);
          }
          const current = consentInEffect(row.details);
          const revised = reviseConsent({
            body: row.body, revision: facts.revision, provenance: hostedFeedback(row).feedback.provenance, details: row.details || {},
            state: facts.state, approvedRevision: row.approved_revision ?? null, retained: facts.retained,
          }, { clarification: current?.clarification === true, feature: body.consent ? { agree: body.revisionSeen } : "decline" }, canonicalTime(now()));
          if (!revised.ok) {
            if (revised.code === "unchanged") return json(200, { item: receiptView(row) }, corsOrigin);
            if (revised.code === "staleRevision") return answered([]);
            return json(422, { error: "Your consent cannot change again on this reflection.", code: revised.code }, corsOrigin);
          }
          const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, id: `eq.${row.id}`, receipt_hash: `eq.${receiptDigest(receipt)}`, status: "in.(pending,clarification,approved)", version: `eq.${version}`, purged_at: "is.null", select: receiptColumns });
          return answered(await database(settings, `/rest/v1/openblog_feedback?${params}`, {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ details: revised.details, version: version + 1 }),
          }));
        }
        if (action === "credit") {
          // A reader's own change to whether the editors may credit them by the name they gave
          // (ADR 0167): for this text as it stands, or withdrawn. It never publishes anything.
          // Agreeing binds the agreement to the current revision, so a later clarification needs
          // fresh agreement; the version is raised so an editor acting on the earlier view is
          // refused instead of acting on a credit that has changed.
          if (row.kind !== FUTURE_SUGGESTION_KIND || !facts.retained) return json(422, { error: "You can change this only on a suggestion that is still kept.", code: "notAllowed" }, corsOrigin);
          const plan = planCredit(row, body.consent);
          if (!plan.ok) return json(422, { error: plan.code === "consentWithoutName" ? "You gave no name to be credited by." : "Choose whether the editors may credit you.", code: plan.code }, corsOrigin);
          const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, id: `eq.${row.id}`, receipt_hash: `eq.${receiptDigest(receipt)}`, version: `eq.${version}`, purged_at: "is.null", select: receiptColumns });
          return answered(await database(settings, `/rest/v1/openblog_feedback?${params}`, {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ publish_name: plan.publish_name, details: plan.details, version: version + 1 }),
          }));
        }
        if (action === "clarify") {
          const plan = planTransition(facts, { action: "clarify", expectedVersion: version, role: "submitter" });
          if (!plan.ok) return json(plan.code === "stale" ? 409 : 422, { error: "Your note is not waiting for clarification.", code: plan.code, item: receiptView(row) }, corsOrigin);
          if (row.kind === THIRD_PERSPECTIVE_KIND) {
            // A Third Perspective's answer replaces its text as the next revision; its category,
            // receipt and consent records stay as they are, with when the answer arrived.
            const answer = normalizeReflection(body.body);
            if (answer === null) return json(422, { error: "Write your reflection in plain text of up to 4,000 characters.", code: "invalidBody" }, corsOrigin);
            const at = canonicalTime(now());
            return answered(await database(settings, "/rest/v1/rpc/openblog_moderate_feedback_item", {
              method: "POST",
              body: JSON.stringify({
                p_site_id: settings.siteId, p_id: row.id, p_expected_version: version, p_from: "clarification", p_to: "pending", p_action: "clarify",
                p_reason: null, p_actor: READER_ACTOR, p_actor_role: "submitter", p_at: at, p_body: answer, p_details: { ...(row.details || {}), revisedAt: at },
              }),
            }));
          }
          if (row.kind === FUTURE_SUGGESTION_KIND) {
            // A suggestion's answer replaces its text as the next revision under the rule its text
            // met; its link, hints, page and contact stay as they are.
            const answer = readClarification(body.body);
            if (answer === null) return json(422, { error: "Write your answer in plain text of up to 2,000 characters.", code: "invalidBody" }, corsOrigin);
            return answered(await database(settings, "/rest/v1/rpc/openblog_moderate_feedback_item", {
              method: "POST",
              body: JSON.stringify({
                p_site_id: settings.siteId, p_id: row.id, p_expected_version: version, p_from: "clarification", p_to: "pending", p_action: "clarify",
                p_reason: null, p_actor: READER_ACTOR, p_actor_role: "submitter", p_at: canonicalTime(now()), p_body: answer, p_details: row.details || {},
              }),
            }));
          }
          // The answer is read exactly as a new submission about the same
          // passage would be, so it meets every rule the first one did.
          const read = readFeedbackSubmissionJson(JSON.stringify({
            version: 1, kind: row.kind, work: row.work, revision: row.revision, target: row.target, body: body.body,
            ...(body.details && typeof body.details === "object" ? { details: body.details } : {}),
          }));
          if (!read.ok) return json(422, { error: read.error.message, code: read.error.code }, corsOrigin);
          return answered(await database(settings, "/rest/v1/rpc/openblog_moderate_feedback_item", {
            method: "POST",
            body: JSON.stringify({
              p_site_id: settings.siteId, p_id: row.id, p_expected_version: version, p_from: "clarification", p_to: "pending", p_action: "clarify",
              p_reason: null, p_actor: READER_ACTOR, p_actor_role: "submitter", p_at: canonicalTime(now()), p_body: read.submission.body, p_details: read.submission.details,
            }),
          }));
        }
        return json(422, { error: "Choose to read, clarify, agree to be asked, change whether it may be featured or your credit, or withdraw your note.", code: "invalid" }, corsOrigin);
      }
      if (operation === "reports") {
        // An abuse report (ADR 0107): accepted only for an item that is
        // public now, answering `unavailable` exactly as for one that does
        // not exist. It never changes the item, is never public and never
        // counted, and names nobody.
        const source = body.source === "comment" || (body.source === "feedback" && settings.feedback) ? body.source : "";
        const id = String(body.id || "").toLowerCase();
        const ground = typeof body.ground === "string" ? body.ground : "";
        const text = body.body === undefined || body.body === null ? "" : String(body.body).trim();
        if (!source || !UUID.test(id) || !REPORT_GROUNDS.includes(ground) || Array.from(text).length > MAX_REPORT_CHARS || /[\u0000-\u0008\u000B\u000C\u000E-\u001F‪-‮⁦-⁩]/.test(text)) {
          return json(422, { error: "Choose why you are reporting it, and write at most 1,000 characters.", code: "invalid" }, corsOrigin);
        }
        const unavailable = () => json(404, { error: "This item cannot be reported.", code: "unavailable" }, corsOrigin);
        const target = await inboxRow(settings, source, id);
        if (!target) return unavailable();
        const facts = inboxFacts(source, target);
        const work = source === "comment" ? target.path : target.work;
        const shown = source === "comment"
          ? facts.state === "approved" && await commentPolicy(settings, work) !== "hidden"
          : isPublishable(facts.kind) && facts.state === "approved" && target.approved_revision === facts.revision && facts.clarificationAsked !== facts.revision
            && (facts.kind !== THIRD_PERSPECTIVE_KIND || perspectivePublic(target) !== false) && await feedbackPolicy(settings, work, facts.kind) !== "hidden";
        if (!facts.retained || !shown) return unavailable();
        // An answer is shown only under a Third Perspective shown now and about its own responder's
        // section (ADR 0134), so a hidden answer, whose parent is gone, answers `unavailable` exactly
        // as an answer that does not exist and its existence does not leak.
        if (source === "feedback" && facts.kind === AUTHOR_RESPONSE_KIND
          && (await answerParentCode(settings, work, target.details?.parent, target.details?.responder?.contributor)).code !== null) return unavailable();
        const mode = await feedbackPolicy(settings, work, "abuse-report");
        if (mode !== "open") return unavailable();
        if (!await consumeQuota(settings, event, "reports", 5, 500)) return json(429, { error: "Too many reports from here. Please try again later.", code: "rateLimited" }, corsOrigin);
        // One item can be reported only so often an hour, and the same report from the same place once.
        if (!await consumeQuota(settings, event, "reports-item", 20, 500, `${source}:${id}`)) return json(202, { status: "pending" }, corsOrigin);
        const claim = await firstTimeThisHour(settings, event, "reports", [source, id]);
        if (!claim) return json(202, { status: "pending" }, corsOrigin);
        await storedOnce(settings, claim, () => database(settings, "/rest/v1/openblog_abuse_reports?select=id", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ site_id: settings.siteId, target_source: source, target_id: id, work, ground, body: text || null, status: "pending", received_at: canonicalTime(now()) }),
        }));
        return json(202, { status: "pending" }, corsOrigin);
      }
      if (operation === "admin/feedback" && event.httpMethod === "GET") {
        // One item by id, whatever its state (Admin re-reads an item before
        // acting on it), or the queue of one state.
        if (query.id !== undefined) {
          if (!UUID.test(String(query.id))) return json(422, { error: "Invalid feedback id." }, corsOrigin);
          const rows = await feedbackRows(settings, { id: `eq.${String(query.id).toLowerCase()}` });
          return json(200, { feedback: rows.map(hostedFeedback) }, corsOrigin);
        }
        const status = MODERATION_STATES.includes(query.status) ? query.status : "pending";
        const kind = query.kind === undefined || query.kind === "" ? "" : String(query.kind);
        if (kind && !Object.hasOwn(FEEDBACK_KINDS, kind)) return json(422, { error: "Unknown feedback kind." }, corsOrigin);
        // B5's own view lists only its four kinds; every other kind is moderated in the inbox.
        const rows = await feedbackRows(settings, { status: `eq.${status}`, kind: kind ? `eq.${kind}` : `in.(${Object.keys(FEEDBACK_KINDS).join(",")})` });
        return json(200, { feedback: rows.map(hostedFeedback) }, corsOrigin);
      }
      if (operation === "admin/feedback" && event.httpMethod === "PATCH") {
        // A change names the state and version the moderator saw (ADR 0083).
        // The database applies it and records its audit event in one
        // statement, only if the row still has both, so concurrent moderation
        // is refused instead of overwritten.
        const id = String(body.id || "").toLowerCase();
        const version = body.expectedVersion;
        if (!UUID.test(id) || !Number.isInteger(version) || version < 1 || version > 2147483647 || !MODERATION_STATES.includes(body.from)) {
          return json(422, { error: "Invalid moderation change." }, corsOrigin);
        }
        const plan = planModeration(body.from, body.action, body.reason);
        if (!plan.ok) return json(422, { error: plan.message, code: plan.code }, corsOrigin);
        const { change } = plan;
        // A Third Perspective's approval must bind the consent it covers, and only the inbox does,
        // so this route never decides one, whether or not the inbox takes Third Perspectives now.
        const stored = await feedbackRows(settings, { id: `eq.${id}` });
        if (stored[0]?.kind === THIRD_PERSPECTIVE_KIND) return json(409, { error: "Third Perspectives are moderated through /admin/moderation.", code: "useModerationInbox" }, corsOrigin);
        // An author response is approved only under a shown parent and never by its own author.
        if (stored[0]?.kind === AUTHOR_RESPONSE_KIND) return json(409, { error: "Author responses are moderated through /admin/moderation.", code: "useModerationInbox" }, corsOrigin);
        // A suggestion's decisions (and the clearing of its identity) are the inbox's: they carry a conversion and its audit.
        if (stored[0]?.kind === FUTURE_SUGGESTION_KIND) return json(409, { error: "Suggestions for future work are moderated through /admin/moderation.", code: "useModerationInbox" }, corsOrigin);
        // With the inbox's schema the change goes through its function, so
        // the item's revisions and the audit event's kind, revision and role
        // are kept as the inbox keeps them (ADR 0106).
        const rows = await applyInboxChange(settings, "feedback", id, change, version, auditActor(body.actor), "site-admin");
        if (Array.isArray(rows) && rows.length === 1) return json(200, { ok: true, item: hostedFeedback(rows[0]) }, corsOrigin);
        const current = await feedbackRows(settings, { id: `eq.${id}` });
        if (!current.length) return json(404, { error: "No such feedback item.", code: "notFound" }, corsOrigin);
        return json(409, { error: "This item changed since you loaded it. Review it again before acting.", code: "conflict", item: hostedFeedback(current[0]) }, corsOrigin);
      }
      if (operation === "admin/moderation") {
        // The one moderation inbox (ADR 0105): comments and passage feedback
        // in one list, decided by the one state machine. Admin calls it with
        // the token, which is the site Admin, naming the role its viewer has
        // on the item's work (ADR 0103); nothing here is public.
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        const protocol = settings.protection ? "protected" : settings.moderation ? "full" : "legacy";
        const sourceOf = (value) => (value === "comment" || (value === "feedback" && settings.feedback) || (value === "report" && settings.protection) ? value : "");
        if (event.httpMethod === "GET") {
          if (query.id !== undefined) {
            const source = sourceOf(query.source);
            if (!UUID.test(String(query.id)) || !source) return json(422, { error: "Name an item by its source and id." }, corsOrigin);
            const row = await inboxRow(settings, source, String(query.id).toLowerCase());
            return json(200, { protocol, thirdPerspectives: settings.thirdPerspectives, items: row ? await inboxItems(settings, [{ source, row }]) : [], next: null }, corsOrigin);
          }
          const state = MODERATION_STATES.includes(query.state) ? query.state : "pending";
          const kind = query.kind === undefined || query.kind === "" ? "" : String(query.kind);
          if (kind && !PARTICIPATION_KINDS.includes(kind)) return json(422, { error: "Unknown participation kind." }, corsOrigin);
          let after = null;
          if (query.after !== undefined && query.after !== "") {
            const match = CURSOR.exec(String(query.after));
            if (!match) return json(422, { error: "Invalid page cursor." }, corsOrigin);
            after = { time: match[1], id: match[2] };
          }
          const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || INBOX_PAGE, 1), 100);
          const sources = [];
          if (!kind || kind === "comment") sources.push("comment");
          if (settings.feedback && (!kind || Object.hasOwn(FEEDBACK_KINDS, kind) || kind === THIRD_PERSPECTIVE_KIND || kind === AUTHOR_RESPONSE_KIND || kind === FUTURE_SUGGESTION_KIND)) sources.push("feedback");
          if (settings.protection && (!kind || kind === "abuse-report")) sources.push("report");
          // Each store's first `limit + 1` rows after the cursor; merged, the
          // first `limit` are this page's, oldest first.
          const merged = (await Promise.all(sources.map((source) => inboxRows(settings, source, { state, kind, after, limit: limit + 1 }))))
            .flat()
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const page = merged.slice(0, limit);
          const last = page.at(-1);
          return json(200, {
            protocol,
            thirdPerspectives: settings.thirdPerspectives,
            items: await inboxItems(settings, page),
            next: merged.length > limit && last ? `${last.key}~${last.id}` : null,
          }, corsOrigin);
        }
        if (event.httpMethod === "PATCH") {
          const source = sourceOf(body.source);
          const id = String(body.id || "").toLowerCase();
          const version = body.expectedVersion;
          const role = body.actorRole === undefined ? "site-admin" : body.actorRole;
          const protectedAction = settings.protection && (body.action === "erase" || (body.action === "uphold-report" && source === "report"));
          // Linking a suggestion to future work is not a moderation transition: the state is unchanged (ADR 0162).
          const linkAction = body.action === "convert" && source === "feedback";
          if (!source || !UUID.test(id) || !Number.isInteger(version) || version < 1 || version > 2147483647 || !MODERATION_STATES.includes(body.from)
            || !(INBOX_ACTIONS.includes(body.action) || protectedAction || linkAction) || !MODERATOR_ROLES.includes(role)) {
            return json(422, { error: "Invalid moderation change.", code: "invalid" }, corsOrigin);
          }
          const row = await inboxRow(settings, source, id);
          if (!row) return json(404, { error: "No such item.", code: "notFound" }, corsOrigin);
          const facts = inboxFacts(source, row);
          const itemOf = async (current) => (await inboxItems(settings, [{ source, row: current }]))[0];
          const conflict = async (current) => json(409, { error: "This item changed since you loaded it. Review it again before acting.", code: "conflict", item: await itemOf(current) }, corsOrigin);
          if (facts.state !== body.from || facts.version !== version) return conflict(row);
          const refused = (code) => json(code === "denied" ? 403 : 422, { error: "This moderation change is not allowed.", code }, corsOrigin);
          const changed = async (rows) => {
            if (Array.isArray(rows) && rows.length === 1) return json(200, { ok: true, item: await itemOf(rows[0]) }, corsOrigin);
            const current = await inboxRow(settings, source, id);
            if (!current) return json(404, { error: "No such item.", code: "notFound" }, corsOrigin);
            return conflict(current);
          };
          if (body.action === "convert") {
            // An author's record that an accepted suggestion became, or is becoming, future work
            // (ADR 0162): only the Admin's chosen role and the stored row decide, and the row is
            // changed only while it still has the version and approval Admin saw. It creates,
            // fetches and publishes nothing; the link is kept in the row's details, and the audit
            // event holds neither the target nor anything the reader wrote.
            if (row.kind !== FUTURE_SUGGESTION_KIND) return json(422, { error: "Only a suggestion for future work can be linked to future work.", code: "wrongKind" }, corsOrigin);
            if (!settings.moderation) return json(422, { error: INBOX_UNAVAILABLE, code: "notAllowed" }, corsOrigin);
            // The link is guarded on `purged_at`, a column only protection reads, and a suggestion is
            // in the inbox only while suggestions are on: without either the write would fail at the
            // store as a bad gateway, so say what to switch on instead.
            if (!settings.suggestions || !settings.protection) return json(422, { error: "Linking a suggestion needs suggestions (OPENBLOG_SUGGESTIONS_ENABLED) and engagement protection (supabase/protection.sql and OPENBLOG_PROTECTION_ENABLED) both switched on.", code: "unavailable" }, corsOrigin);
            const at = canonicalTime(now());
            const actor = auditActor(body.actor);
            const plan = planConversion(row, { role, kind: body.conversion?.kind, target: body.conversion?.id, actor, at });
            if (!plan.ok) return plan.code === "denied" ? refused("denied") : json(422, { error: "This link is not allowed.", code: plan.code }, corsOrigin);
            const params = new URLSearchParams({
              site_id: `eq.${settings.siteId}`, id: `eq.${id}`, version: `eq.${facts.version}`, status: "eq.approved",
              approved_revision: `eq.${facts.revision}`, kind: `eq.${FUTURE_SUGGESTION_KIND}`, purged_at: "is.null", select: FEEDBACK_PROTECTED_COLUMNS,
            });
            const rows = await database(settings, `/rest/v1/openblog_feedback?${params}`, {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify({ details: plan.details, version: facts.version + 1 }),
            });
            if (Array.isArray(rows) && rows.length === 1) {
              await database(settings, "/rest/v1/openblog_feedback_events", {
                method: "POST",
                headers: { Prefer: "return=minimal" },
                body: JSON.stringify({
                  site_id: settings.siteId, feedback_id: id, action: "convert", from_status: "approved", to_status: "approved", reason: null,
                  actor, at, version: facts.version + 1, kind: FUTURE_SUGGESTION_KIND, item_revision: facts.revision, actor_role: role,
                }),
              }).catch((error) => console.error("open.blog engagement: could not record a link event:", error.message));
            }
            return changed(rows);
          }
          if (body.action === "erase") {
            // A deletion request taken by the site Admin (ADR 0107).
            const plan = planErasure(facts, role, version);
            if (!plan.ok) return plan.code === "stale" ? conflict(row) : refused(plan.code);
            const at = canonicalTime(now());
            const actor = auditActor(body.actor);
            if (source === "feedback") {
              return changed(await database(settings, "/rest/v1/rpc/openblog_erase_feedback", {
                method: "POST",
                body: JSON.stringify({ p_site_id: settings.siteId, p_id: id, p_expected_version: version, p_withdraw: false, p_actor: actor, p_actor_role: role, p_at: at }),
              }));
            }
            return changed(await database(settings, `/rest/v1/rpc/${source === "comment" ? "openblog_purge_comment" : "openblog_purge_report"}`, {
              method: "POST",
              body: JSON.stringify({ p_site_id: settings.siteId, p_id: id, p_expected_version: version, p_actor: actor, p_actor_role: role, p_at: at }),
            }));
          }
          if (body.action === "uphold-report") {
            // Upheld with the item the report names, exactly as Admin saw it
            // (ADR 0104): removed in the same transaction while approved.
            const targetSource = row.target_source;
            const target = targetSource === "comment" || (targetSource === "feedback" && settings.feedback) ? await inboxRow(settings, targetSource, String(row.target_id).toLowerCase()) : null;
            const targetFacts = target ? inboxFacts(targetSource, target) : null;
            if ((targetFacts ? targetFacts.version : null) !== (body.targetVersion ?? null)) return conflict(row);
            const plan = planUphold(facts, target ? { id: String(target.id).toLowerCase(), state: targetFacts.state, version: targetFacts.version } : null, { role, reason: body.reason, expectedVersion: version });
            if (!plan.ok) return plan.code === "stale" ? conflict(row) : refused(plan.code);
            const result = await database(settings, "/rest/v1/rpc/openblog_uphold_report", {
              method: "POST",
              body: JSON.stringify({
                p_site_id: settings.siteId, p_id: id, p_expected_version: version, p_target_version: plan.removal ? targetFacts.version : null,
                p_reason: plan.change.reason, p_actor: auditActor(body.actor), p_actor_role: role, p_at: canonicalTime(now()),
              }),
            });
            if (!result || typeof result !== "object" || !result.report) {
              const current = await inboxRow(settings, source, id);
              return current ? conflict(current) : json(404, { error: "No such item.", code: "notFound" }, corsOrigin);
            }
            const removed = result.target && typeof result.target === "object" ? (await inboxItems(settings, [{ source: targetSource, row: result.target }]))[0] : null;
            return json(200, { ok: true, item: await itemOf(result.report), removed }, corsOrigin);
          }
          // Decided again here, from the stored row, before anything is written.
          const plan = planTransition(facts, { action: body.action, expectedVersion: version, reason: body.reason, role });
          if (!plan.ok) {
            if (plan.code === "stale") return conflict(row);
            return refused(plan.code);
          }
          if (!settings.moderation && !legacySupports(facts.kind, body.action)) {
            return json(422, { error: INBOX_UNAVAILABLE, code: "notAllowed" }, corsOrigin);
          }
          if (source === "feedback" && facts.kind === THIRD_PERSPECTIVE_KIND) {
            // An approval binds exactly the text revision and consent record the moderator saw
            // (ADR 0111), checked here and again by the database in the same statement.
            if (!settings.thirdPerspectives) {
              if (plan.change.to === "approved") return json(422, { error: PERSPECTIVE_INBOX_UNAVAILABLE, code: "notAllowed" }, corsOrigin);
              return changed(await applyInboxChange(settings, source, id, plan.change, version, auditActor(body.actor), role));
            }
            let consent = null;
            if (plan.change.to === "approved") {
              const check = checkThirdPerspectiveApproval(row, body.seenRevision, body.seenConsent);
              if (!check.ok) return check.code === "staleRevision" || check.code === "staleConsent" ? conflict(row) : refused(check.code);
              consent = check.consent;
            }
            return changed(await applyPerspectiveChange(settings, id, plan.change, version, auditActor(body.actor), role, consent));
          }
          if (source === "feedback" && facts.kind === AUTHOR_RESPONSE_KIND) {
            // An answer is approved only where the service records answers, only under a Third
            // Perspective that is shown now and about its own author's section, and never by the
            // account that wrote it (ADR 0128); anything else about it is decided like any item.
            if (plan.change.to === "approved") {
              if (!settings.authorResponses) return json(422, { error: ANSWER_UNAVAILABLE, code: "notAllowed" }, corsOrigin);
              if (!mayDecideResponse(row.details?.binding?.account, auditActor(body.actor), "approve")) return refused("denied");
              const { code } = await answerParentCode(settings, row.work, row.details?.parent, row.details?.responder?.contributor);
              if (code) return answerParentRefusal(code, corsOrigin, await itemOf(row));
              // Two answers written in the same instant can both be stored pending (no constraint
              // stops it without a schema change), so at most one is ever shown: approving one while
              // another is shown under the same parent is refused (ADR 0132).
              const shown = new URLSearchParams({
                site_id: `eq.${settings.siteId}`, kind: `eq.${AUTHOR_RESPONSE_KIND}`, "details->>parent": `eq.${row.details?.parent}`,
                status: "eq.approved", purged_at: "is.null", id: `neq.${row.id}`, select: "id", limit: "1",
              });
              const others = await database(settings, `/rest/v1/openblog_feedback?${shown}`);
              if (Array.isArray(others) && others.length) {
                return json(409, { error: "Another answer to this reflection is already shown. Reject or remove one of them.", code: "alreadyAnswered" }, corsOrigin);
              }
            }
            return changed(await applyInboxChange(settings, source, id, plan.change, version, auditActor(body.actor), role));
          }
          return changed(await applyInboxChange(settings, source, id, plan.change, version, auditActor(body.actor), role));
        }
      }
      if (operation === "admin/author-response") {
        // An author's answer to a Third Perspective (ADRs 0131 and 0132). Admin has already checked,
        // against the private shared-publication record this function never holds, that the signed-in
        // account is the contributor bound to the section; the function reads the request strictly,
        // reads the parent from its own store and checks it again, and stores the answer pending.
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        if (!settings.authorResponses) return json(404, { error: ANSWER_UNAVAILABLE, code: "unavailable" }, corsOrigin);
        if (event.httpMethod === "POST") {
          const text = event.isBase64Encoded ? Buffer.from(String(event.body || ""), "base64").toString("utf8") : String(event.body || "");
          const read = readAuthorResponseRequest(text);
          if (!read.ok) {
            const { code, message } = read.error;
            return json(code === "tooLarge" ? 413 : 422, { error: message, code }, corsOrigin);
          }
          const answer = read.request;
          const policy = await feedbackPolicy(settings, answer.work, AUTHOR_RESPONSE_KIND);
          if (policy !== "open") {
            return json(403, policy === "locked"
              ? { error: "This work is not taking author responses now.", code: "closed" }
              : { error: ANSWER_UNAVAILABLE, code: "unavailable" }, corsOrigin);
          }
          const { code, parent } = await answerParentCode(settings, answer.work, answer.parent.id, answer.responder.contributor);
          if (code) return answerParentRefusal(code, corsOrigin);
          if ((parent.version ?? 1) !== answer.parent.version) {
            return json(409, { error: "That reflection changed since you loaded it. Review it again before answering.", code: "conflict" }, corsOrigin);
          }
          const existing = new URLSearchParams({
            site_id: `eq.${settings.siteId}`, kind: `eq.${AUTHOR_RESPONSE_KIND}`, "details->>parent": `eq.${answer.parent.id}`,
            status: "in.(pending,approved)", purged_at: "is.null", select: "id", limit: "1",
          });
          const answered = await database(settings, `/rest/v1/openblog_feedback?${existing}`);
          if (Array.isArray(answered) && answered.length) {
            return json(409, { error: "This reflection already has an answer waiting or shown. Withdraw it first to write another.", code: "alreadyAnswered" }, corsOrigin);
          }
          if (!await consumeQuota(settings, event, "author-response", 20, 500, answer.responder.account)) {
            return json(429, { error: "Too many answers just now. Please try again later.", code: "rateLimited" }, corsOrigin);
          }
          const claim = await firstTimeThisHour(settings, event, "author-response", [answer.work, answer.parent.id, answer.body]);
          if (!claim) return json(409, { error: "This answer was already sent and is waiting for review.", code: "duplicate" }, corsOrigin);
          const row = receiveAuthorResponse(answer, { revision: parent.revision, target: parent.target }, canonicalTime(now()));
          const rows = await storedOnce(settings, claim, () => database(settings, "/rest/v1/openblog_feedback?select=id,status,received_at", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ site_id: settings.siteId, ...row, status: "pending" }),
          }));
          return json(202, { id: rows[0]?.id, status: "pending", receivedAt: row.received_at }, corsOrigin);
        }
        if (event.httpMethod === "PATCH") {
          // The author takes their own answer back. The row, its responder and its audit trail stay
          // (retention purges the text later, as for any closed item); it is never public again.
          const id = String(body.id || "").toLowerCase();
          const version = body.expectedVersion;
          const actor = typeof body.actor === "string" && /^[a-z0-9_.-]{1,32}$/.test(body.actor) ? body.actor : "";
          if (!UUID.test(id) || !Number.isInteger(version) || version < 1 || version > 2147483647 || !actor) {
            return json(422, { error: "Invalid withdrawal.", code: "invalid" }, corsOrigin);
          }
          const row = await inboxRow(settings, "feedback", id);
          if (!row || row.kind !== AUTHOR_RESPONSE_KIND || row.details?.binding?.account !== actor) {
            return json(404, { error: "No such answer.", code: "notFound" }, corsOrigin);
          }
          const plan = planTransition(inboxFacts("feedback", row), { action: "withdraw", expectedVersion: version, role: "submitter" });
          if (!plan.ok) return json(plan.code === "stale" ? 409 : 422, { error: "This answer cannot be withdrawn now.", code: plan.code === "stale" ? "conflict" : plan.code, item: inboxFeedback(row) }, corsOrigin);
          const rows = await applyInboxChange(settings, "feedback", id, plan.change, version, actor, "contributing-author");
          if (Array.isArray(rows) && rows.length === 1) return json(200, { ok: true, item: inboxFeedback(rows[0]) }, corsOrigin);
          const current = await inboxRow(settings, "feedback", id);
          return json(409, { error: "Your answer changed since you loaded it.", code: "conflict", item: current ? inboxFeedback(current) : null }, corsOrigin);
        }
        return json(405, { error: "Use POST to answer and PATCH to withdraw." }, corsOrigin);
      }
      if (operation === "admin/decisions") {
        // The author's correction decision on an evidence submission (ADR 0117), decided by Admin
        // with the viewer's role on the item's work, checked again here from the stored row, and
        // appended to the item's log with its audit event in one conditional statement, only while
        // the item still has the text revision and the number of decisions both saw. It never
        // changes the item's state, version or approval, and nothing is e-mailed to anyone.
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        if (!settings.corrections) {
          return json(404, { error: "Run supabase/feedback.sql again and set OPENBLOG_CORRECTIONS_ENABLED=true to record correction decisions.", code: "unavailable" }, corsOrigin);
        }
        if (event.httpMethod !== "POST") return json(405, { error: "Use POST." }, corsOrigin);
        const id = String(body.id || "").toLowerCase();
        const expectedDecisions = body.expectedDecisions;
        const role = body.actorRole === undefined ? "site-admin" : body.actorRole;
        if (!UUID.test(id) || !Number.isInteger(expectedDecisions) || expectedDecisions < 0 || expectedDecisions > 1000) {
          return json(422, { error: "Invalid correction decision.", code: "invalid" }, corsOrigin);
        }
        const row = await inboxRow(settings, "feedback", id);
        if (!row) return json(404, { error: "No such item.", code: "notFound" }, corsOrigin);
        const itemOf = async (current) => (await inboxItems(settings, [{ source: "feedback", row: current }]))[0];
        const conflict = async (current) => json(409, { error: "Someone decided on this item, or it changed, since you loaded it. Review it again before deciding.", code: "conflict", item: await itemOf(current) }, corsOrigin);
        const facts = { ...inboxFacts("feedback", row), id, decisions: decisionsOf(row.decisions).length };
        if (!facts.retained) return json(422, { error: "This item’s text was deleted; it takes no decision.", code: "itemClosed" }, corsOrigin);
        const plan = planDecision(facts, { role, expectedDecisions, decision: body.decision });
        if (!plan.ok) {
          if (plan.code === "stale") return conflict(row);
          return json(plan.code === "denied" ? 403 : 422, { error: "This correction decision is not allowed.", code: plan.code }, corsOrigin);
        }
        const rows = await database(settings, "/rest/v1/rpc/openblog_record_feedback_decision", {
          method: "POST",
          body: JSON.stringify({
            p_site_id: settings.siteId, p_id: id, p_expected_decisions: expectedDecisions, p_item_revision: facts.revision,
            p_decision: body.decision, p_actor: auditActor(body.actor), p_actor_role: role, p_at: canonicalTime(now()),
          }),
        });
        if (Array.isArray(rows) && rows.length === 1) return json(200, { ok: true, item: await itemOf(rows[0]) }, corsOrigin);
        const current = await inboxRow(settings, "feedback", id);
        return current ? conflict(current) : json(404, { error: "No such item.", code: "notFound" }, corsOrigin);
      }
      if (operation === "admin/retention") {
        // The retention job (ADRs 0104 and 0108), run by the site Admin from
        // Admin: GET is its dry run, the items due and the audit events old
        // enough to delete; POST applies exactly the items Admin confirmed,
        // each only while it is still as it was and still due. Nothing runs
        // on its own, and comments are touched only when Admin says the site
        // opted them in.
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        if (!settings.protection) return json(404, { error: "Run supabase/protection.sql and set OPENBLOG_PROTECTION_ENABLED=true to run retention.", code: "unavailable" }, corsOrigin);
        const input = event.httpMethod === "GET" ? query : body;
        const cutoffs = retentionCutoffs(input);
        if (!cutoffs) return json(422, { error: "Send the run's cutoffs, each at least a day in the past, with audit events kept at least as long as closed items.", code: "invalid" }, corsOrigin);
        const sources = [...(cutoffs.comments ? ["comment"] : []), ...(settings.feedback ? ["feedback"] : []), "report"];
        if (event.httpMethod === "GET") {
          const due = [];
          let truncated = false;
          for (const source of sources) {
            const rows = await retentionCandidates(settings, source, cutoffs);
            truncated ||= rows.length >= RETENTION_BATCH;
            for (const row of rows) {
              const step = retentionStep(inboxFacts(source, row), cutoffs);
              if (step) due.push({ source, row, step });
            }
          }
          // Facts are enough here: a report's item is not read for the dry run.
          return json(200, {
            protocol: "protected",
            items: due.map(({ source, row, step }) => ({ ...inboxItem(source, row, null), step })),
            audit: await auditDue(settings, cutoffs, false),
            truncated,
          }, corsOrigin);
        }
        if (event.httpMethod === "POST") {
          const wanted = Array.isArray(body.items) ? body.items : null;
          if (!wanted || wanted.length > RETENTION_BATCH || !wanted.every((item) => sources.includes(item?.source) && UUID.test(String(item.id || "")) && Number.isInteger(item.version) && ["expire", "purge-content", "scrub-identity"].includes(item.step))) {
            return json(422, { error: "Send at most 200 items the dry run listed.", code: "invalid" }, corsOrigin);
          }
          const done = { expired: 0, purged: 0, scrubbed: 0, skipped: 0 };
          const at = canonicalTime(now());
          for (const item of wanted) {
            const id = String(item.id).toLowerCase();
            const row = await inboxRow(settings, item.source, id);
            const facts = row ? inboxFacts(item.source, row) : null;
            if (!facts || facts.version !== item.version || retentionStep(facts, cutoffs) !== item.step) {
              done.skipped += 1;
              continue;
            }
            let rows;
            if (item.step === "expire") {
              const change = { action: "expire", from: facts.state, to: "rejected", reason: "expired" };
              rows = await applyInboxChange(settings, item.source, id, change, facts.version, RETENTION_ACTOR, "system");
            } else if (item.step === "scrub-identity") {
              // Clears the kept suggestion's contact and unpublished name and nothing else, only
              // while it is still the approved suggestion the dry run listed, raising its version
              // so no view from before can act on it (ADR 0155).
              const cleared = scrubbedIdentity(row);
              const params = new URLSearchParams({
                site_id: `eq.${settings.siteId}`, id: `eq.${id}`, version: `eq.${facts.version}`, status: "eq.approved",
                kind: `eq.${FUTURE_SUGGESTION_KIND}`, purged_at: "is.null", select: "id,version",
              });
              rows = await database(settings, `/rest/v1/openblog_feedback?${params}`, {
                method: "PATCH",
                headers: { Prefer: "return=representation" },
                body: JSON.stringify({ details: cleared.details, reader_name: cleared.reader_name, version: facts.version + 1 }),
              });
              if (Array.isArray(rows) && rows.length === 1) {
                // The event holds no text, name or contact. The data change above is the one that
                // matters, so a failure to log it is reported, not retried against the row.
                await database(settings, "/rest/v1/openblog_feedback_events", {
                  method: "POST",
                  headers: { Prefer: "return=minimal" },
                  body: JSON.stringify({
                    site_id: settings.siteId, feedback_id: id, action: "scrub-identity", from_status: "approved", to_status: "approved", reason: null,
                    actor: RETENTION_ACTOR, at, version: facts.version + 1, kind: FUTURE_SUGGESTION_KIND, item_revision: facts.revision, actor_role: "system",
                  }),
                }).catch((error) => console.error("open.blog engagement: could not record a scrub event:", error.message));
              }
            } else if (item.source === "feedback") {
              rows = await database(settings, "/rest/v1/rpc/openblog_erase_feedback", {
                method: "POST",
                body: JSON.stringify({ p_site_id: settings.siteId, p_id: id, p_expected_version: facts.version, p_withdraw: false, p_actor: RETENTION_ACTOR, p_actor_role: "system", p_at: at }),
              });
            } else {
              rows = await database(settings, `/rest/v1/rpc/${item.source === "comment" ? "openblog_purge_comment" : "openblog_purge_report"}`, {
                method: "POST",
                body: JSON.stringify({ p_site_id: settings.siteId, p_id: id, p_expected_version: facts.version, p_actor: RETENTION_ACTOR, p_actor_role: "system", p_at: at }),
              });
            }
            if (Array.isArray(rows) && rows.length === 1) done[item.step === "expire" ? "expired" : item.step === "scrub-identity" ? "scrubbed" : "purged"] += 1;
            else done.skipped += 1;
          }
          const audit = body.audit === true ? await auditDue(settings, cutoffs, true) : null;
          console.info(`open.blog engagement: retention expired ${done.expired}, purged ${done.purged}, cleared ${done.scrubbed}, skipped ${done.skipped}`);
          return json(200, { ok: true, ...done, auditDeleted: audit }, corsOrigin);
        }
        return json(405, { error: "Use GET for the dry run and POST to run it." }, corsOrigin);
      }
      if (operation === "admin/comments" && event.httpMethod === "GET") {
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        const status = ["pending", "approved", "rejected"].includes(query.status) ? query.status : "pending";
        const params = new URLSearchParams({ site_id: `eq.${settings.siteId}`, status: `eq.${status}`, select: "id,path,author_name,body,status,created_at", order: "created_at.asc", limit: "200" });
        const rows = await database(settings, `/rest/v1/openblog_comments?${params}`);
        return json(200, { comments: rows.map(publicComment).map((comment, index) => ({ ...comment, path: rows[index].path })) }, corsOrigin);
      }
      if (operation === "admin/comments" && event.httpMethod === "PATCH") {
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        // With the inbox's schema, a bare status change would skip the
        // comment's version, its full state and its audit event (ADR 0106).
        if (settings.moderation) return json(409, { error: "Comments are moderated through /admin/moderation on this site.", code: "useModerationInbox" }, corsOrigin);
        const id = String(body.id || "");
        const status = String(body.status || "");
        if (!/^[0-9a-f-]{36}$/i.test(id) || !["approved", "rejected"].includes(status)) return json(422, { error: "Invalid moderation change." }, corsOrigin);
        await database(settings, `/rest/v1/openblog_comments?id=eq.${encodeURIComponent(id)}&site_id=eq.${encodeURIComponent(settings.siteId)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status, moderated_at: now().toISOString() }),
        });
        return json(200, { ok: true, status }, corsOrigin);
      }
      if (operation === "hit" && event.httpMethod === "POST") {
        if (event.headers?.dnt === "1" || event.headers?.["sec-gpc"] === "1") {
          return { statusCode: 204, headers: corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {}, body: "" };
        }
        const path = cleanPath(body.path);
        if (!path) return json(400, { error: "Invalid page path." }, corsOrigin);
        const day = now().toISOString().slice(0, 10);
        const address = String(event.headers?.["x-nf-client-connection-ip"] || event.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
        const agent = String(event.headers?.["user-agent"] || "").slice(0, 500);
        const visitor = createHash("sha256").update(`${settings.salt}\0${day}\0${address}\0${agent}`).digest("hex");
        if (!await consumeQuota(settings, event, "analytics", 120, 20000, address)) return json(429, { error: "Analytics rate limit reached." }, corsOrigin);
        let referrer = "";
        try { referrer = new URL(String(body.referrer || "")).hostname.toLowerCase().slice(0, 253); } catch { /* no referrer */ }
        const result = await database(settings, "/rest/v1/rpc/openblog_record_view", {
          method: "POST",
          body: JSON.stringify({ p_site_id: settings.siteId, p_day: day, p_path: path, p_visitor_hash: visitor, p_referrer: referrer }),
        });
        return json(200, { views: Number(result?.views ?? result ?? 0) }, corsOrigin);
      }
      if (operation === "views" && event.httpMethod === "GET") {
        const path = cleanPath(query.path);
        if (!path) return json(400, { error: "Invalid page path." }, corsOrigin);
        const result = await database(settings, "/rest/v1/rpc/openblog_page_views", { method: "POST", body: JSON.stringify({ p_site_id: settings.siteId, p_path: path }) });
        return json(200, { views: Number(result?.views ?? result ?? 0) }, corsOrigin);
      }
      if (operation === "admin/analytics" && event.httpMethod === "GET") {
        if (!admin) return json(401, { error: "Admin authorization is required." }, corsOrigin);
        const days = [7, 30, 90, 365].includes(Number(query.days)) ? Number(query.days) : 30;
        const result = await database(settings, "/rest/v1/rpc/openblog_analytics_summary", { method: "POST", body: JSON.stringify({ p_site_id: settings.siteId, p_days: days }) });
        return json(200, result, corsOrigin);
      }
      return json(404, { error: "No such engagement operation." }, corsOrigin);
    } catch (error) {
      console.error("open.blog engagement:", error.message);
      return json(502, { error: "The hosted data service is unavailable." }, corsOrigin);
    }
  };
}

export const handler = createHandler();
