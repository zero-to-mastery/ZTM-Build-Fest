// The moderation rules for passage feedback (ADR 0083): B5's subset of the one state machine
// (participation-moderation.mjs, ADR 0102), the same table as `openblog_core::feedback_moderation`,
// held together by tests/fixtures/feedback-moderation.json. The states, reasons and refusal codes
// are the policy's; B5's route offers only approve, reject and remove, as the site Admin. Reasons
// are moderation grounds, never a verdict on facts.

import { MODERATION_STATES as STATES, allowedReasons, nextState, planTransition } from "./participation-moderation.mjs";

export const MODERATION_STATES = STATES;

const FEEDBACK_ACTIONS = ["approve", "reject", "remove"];

export const MODERATION_ACTIONS = Object.freeze(Object.fromEntries(FEEDBACK_ACTIONS.map((action) => {
  const from = STATES.filter((state) => nextState(action, state));
  return [action, Object.freeze({ from: Object.freeze(from), to: nextState(action, from[0]), reasons: allowedReasons(action, "question") })];
})));

/**
 * An Admin account name the audit trail may record, or the token's own name. Account names follow
 * `openblog_core::collaboration::valid_admin_username`: 1 to 32 of `a-z`, `0-9`, `_`, `.` and `-`.
 */
export const MODERATION_TOKEN_ACTOR = "@moderation-token";
export const auditActor = (value) => {
  const actor = typeof value === "string" ? value : "";
  return /^[a-z0-9_.-]{1,32}$/.test(actor) ? actor : MODERATION_TOKEN_ACTOR;
};

/**
 * Check one requested change against the item's current state, as the one state machine decides
 * it for the site Admin. Every combination the table does not list is refused; nothing is guessed.
 */
export function planModeration(current, action, reason) {
  if (!FEEDBACK_ACTIONS.includes(action)) return { ok: false, code: "notAllowed", message: "Choose approve, reject or remove." };
  const plan = planTransition(
    { kind: "question", state: current, version: 1, revision: 1, clarificationAsked: null, clarificationConsent: false },
    { action, expectedVersion: 1, reason, role: "site-admin" },
  );
  if (plan.ok) return { ok: true, change: { action, from: current, to: plan.change.to, reason: plan.change.reason } };
  const messages = {
    notAllowed: `An item that is ${current} cannot be changed with ${action}.`,
    reasonRequired: `Choose a reason to ${action}.`,
    reasonNotAllowed: allowedReasons(action, "question").length ? "Choose one of the listed reasons." : `${action} takes no reason.`,
  };
  return { ok: false, code: plan.code, message: messages[plan.code] || "This change is not allowed." };
}
