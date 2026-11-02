// The author's correction decisions on evidence submissions (ADR 0117), as the hosted function
// checks them again before storing one: the part of `openblog_core::correction_decision::decide`
// that depends only on the stored row and the decider's role, in the same order (grant, kind,
// state, clarification, decisions seen), with the same codes, held together with the Rust policy
// by the `decisions` cases of tests/fixtures/evidence-corrections.json. Admin decides the whole
// decision first (its fields, the revision note in the post, the claim evidence link, the passage
// check); this module makes sure that what reaches storage is a well-formed next entry of the
// item's log, about the text as it is now, from a role that may decide.
//
// A decision is not a moderation action: it never changes the item's state, version or approval,
// and it never labels anything before the author records it.

export const DECISION_VERSION = 1;
export const MAX_DECISIONS_PER_ITEM = 100;
// A stored decision is the author's short rationale and a few ids; anything larger is not one.
export const MAX_DECISION_BYTES = 8 * 1024;
export const EVIDENCE_KINDS = Object.freeze(["source-suggestion", "correction-suggestion"]);
export const DECISION_OUTCOMES = Object.freeze(["accepted-as-correction", "accepted-as-clarification", "accepted-as-evidence", "declined", "already-addressed"]);
// The roles that may decide: the approve row of ADR 0103's grants, resolved by Admin on the item's
// work. The token itself is the site Admin.
export const DECIDER_ROLES = Object.freeze(["site-admin", "coordinator"]);

const DECISION_FIELDS = new Set([
  "version", "item", "sequence", "outcome", "extent", "declineReason", "rationale", "revisionNote", "claimEvidence", "addressedBy",
  "itemRevision", "passageRevision", "passageCheck", "decided", "decidedBy",
]);
const DAY = /^\d{4}-\d\d-\d\d$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The decisions a stored log holds, or none for an item nobody decided. */
export const decisionsOf = (log) => (isObject(log) && Array.isArray(log.decisions) ? log.decisions : []);

/** An empty log for an item, as an item nobody decided reads. */
export const emptyLog = (id) => ({ version: DECISION_VERSION, item: String(id).toLowerCase(), decisions: [] });

/**
 * Whether `facts` (the stored row's kind, state, revision, the revision a clarification asked about
 * and how many decisions its log holds) let `role` record `decision` as the log's next entry, seen
 * with `expectedDecisions` decisions. Returns { ok: true } or { ok: false, code } with the policy's
 * codes: denied, notDecidable, itemClosed, awaitingClarification, stale, tooManyDecisions and
 * malformed.
 */
export function planDecision(facts, { role, expectedDecisions, decision }) {
  if (!DECIDER_ROLES.includes(role)) return { ok: false, code: "denied" };
  if (!EVIDENCE_KINDS.includes(facts.kind)) return { ok: false, code: "notDecidable" };
  if (facts.state === "clarification") return { ok: false, code: "awaitingClarification" };
  if (facts.state !== "pending" && facts.state !== "approved") return { ok: false, code: "itemClosed" };
  if (facts.clarificationAsked === facts.revision) return { ok: false, code: "awaitingClarification" };
  if (expectedDecisions !== facts.decisions) return { ok: false, code: "stale" };
  if (facts.decisions >= MAX_DECISIONS_PER_ITEM) return { ok: false, code: "tooManyDecisions" };
  // Admin read the text as it was when the author looked: a clarification the reader answered
  // since changed it, and the decision is about words that are gone.
  if (isObject(decision) && Number.isInteger(decision.itemRevision) && decision.itemRevision !== facts.revision) return { ok: false, code: "stale" };
  const wellFormed =
    isObject(decision) &&
    Object.keys(decision).every((key) => DECISION_FIELDS.has(key)) &&
    byteLength(decision) <= MAX_DECISION_BYTES &&
    decision.version === DECISION_VERSION &&
    decision.item === facts.id &&
    decision.sequence === facts.decisions + 1 &&
    decision.itemRevision === facts.revision &&
    DECISION_OUTCOMES.includes(decision.outcome) &&
    typeof decision.passageCheck === "string" &&
    typeof decision.decided === "string" &&
    DAY.test(decision.decided) &&
    isObject(decision.decidedBy) &&
    decision.decidedBy.role === role;
  return wellFormed ? { ok: true } : { ok: false, code: "malformed" };
}
