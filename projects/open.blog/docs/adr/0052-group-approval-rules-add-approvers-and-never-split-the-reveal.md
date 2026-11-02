# ADR 0052: Group approval rules add approvers, and the reveal is never split into groups

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#187](https://github.com/journey-to-code-org/open.blog/issues/187)
- Parent story: [#152](https://github.com/journey-to-code-org/open.blog/issues/152)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0018](0018-reveal-policy-readiness-and-comparison.md),
  [ADR 0020](0020-approval-snapshots-bound-to-exact-content.md),
  [ADR 0021](0021-combined-review-preview.md),
  [ADR 0022](0022-gate-schedule-and-publication-on-exact-approvals.md),
  [ADR 0051](0051-groups-use-the-same-invitation-seam-and-an-audited-membership.md)

## Context

The issue asks for all-participant, named-participant and role-based readiness and approval rules,
with a clear policy snapshot and deterministic invalidation. The approval set already held a policy
(`allAuthors` or `contributingAuthors`, and a scope) that was bound into every approval, but
nothing could change it (ADR 0022). ADR 0018 fixed that a publication has one author set and that
voluntary reveal visibility is derived from the active, ready participants and never split into
stored groups.

## Decision

- **Approval rules.** `ApprovalRequirement` gains `namedAuthors` (participant ids) and
  `authorsWithRoles` (publication roles), next to `allAuthors` (all participants, the default) and
  `contributingAuthors`. Under every rule, each author who owns a section and each author named on
  a synthesis item must approve: nobody's words publish without their own consent. A rule only
  adds approvers on top of that floor. So a quorum can never stand in for a writer, and a named or
  role rule cannot leave anyone out.
- **No fabricated approvals.** Each required person counts only through their own standing
  approval, recomputed against the content (ADR 0020). There is no count, vote or threshold. A
  rule change never records, keeps or moves an approval. Someone a rule does not require stays
  "awaiting, not required" and is never shown or counted as approving.
- **Fail closed on churn.** A named participant who is no longer an author (removed, or lost the
  draft grant), and a listed role that no current author holds (for example, the only coordinator
  left), keep the piece blocked. `Readiness::Blocked` carries these as `gaps`, and the gate refuses
  with `AssemblyError::RuleUnmet`. Losing a person never lowers the bar. Role pairs reach the
  approval subject only through `assembly::with_subject`, read from the bindings of the active
  authors.
- **Canonical snapshot.** A policy has one canonical form: named ids sorted, roles in declaration
  order, no empty or repeated list. A stored set whose policy is not canonical fails to load. The
  policy and its revision are bound into every approval, so a real change makes every standing
  approval stale and also clears them. Changing back cannot revive them, because the revision
  moved on. Existing sets load unchanged and their approvals stay valid: the old variants' binding
  input is identical.
- **Changing a rule.** A new action, `SetApprovalPolicy`, targets the publication and is held by
  site owners and coordinators (a coordinator only within the limit below). `GET/PUT
  /admin/api/collaboration/approval-policy` go through `SharedPublication::authorize`, and every
  refusal to someone without the grant is the same 404. A change needs the policy
  revision the requester read (409 if it moved) and an explicit `confirmed` (422 without it),
  because it clears every approval. Resubmitting the current rule in any order is a no-op that
  writes nothing. A rule the authors as they are now could never meet is refused: a named person,
  or an author a role rule adds, who cannot approve, or a listed role no author holds. The write is
  a compare-and-swap on the approvals file, so a concurrent approval or rule change is a conflict,
  never an overwrite. The response re-evaluates the piece under the new rule (who must approve,
  who still has to, what cannot be met). A published reflection's rule no longer changes. A
  scheduled publication meets the new rule when it falls due, like any other change (ADR 0022).
- **Coordinators only keep or add required approvers (amends ADR 0020).** ADR 0020 gave the
  policy to the site owner. Coordinators now hold `SetApprovalPolicy` too, but without a limit a
  coordinator could drop a site owner who wrote nothing from the people whose consent publication
  waits on. So a rule change carries the requester's authority (`RuleAuthority`, read from the
  binding the grant came from). The required sets before and after are computed against the
  piece and the authors as they are now, and a coordinator's change must keep everyone required
  before. Adding people, changing the scope, or expressing the same people under another rule is
  allowed. A change that drops anyone, including a named participant who has since left (losing
  a person never lowers the bar), is refused with 403 and the names of the people it would drop,
  and only a site owner may make it. The read response says whether the requester may drop
  approvers (`mayDropApprovers`), so Admin can say so before they try.
- **Shown with the piece.** The combined preview carries the rule (policy, revision, a plain
  sentence, and anything that cannot be met), in its summary and in the document, like everything
  else that binds. The Admin "Approval rule" block, inside the sharing section, is shown only to
  people who may change the rule. It uses labelled radio and checkbox controls and a confirmation
  checkbox, and moves focus to the heading after a save or to the alert after a failure.
- **Withdrawn contributors.** A participant who withdrew or never wrote has no section. Under
  `allAuthors` they still block, and the explicit ways out are: they approve the piece without a
  section, a coordinator changes the rule (for example to `contributingAuthors`, or names the
  people who must approve), or the maintainer changes their role. A named approver who is removed
  blocks until a site owner takes them off the rule or their access is restored; a coordinator
  cannot drop them, because losing a named person never lowers the bar on a coordinator's say-so.
  An unmet role blocks until a coordinator changes the rule or an author is given that role. Both
  are shown in the preview, the rule block and the gate's refusal, as display names only, and each
  names who can resolve it. The rule read lists such named people
  (`formerApprovers`), and Admin shows each as a chosen row marked "can no longer approve" that
  can be cleared, so a rule is never saved with someone kept in it unseen.
- **The reveal stays one group (reconciling the issue with ADR 0018).** A named or role-based
  *reveal* rule would either show prose to a sub-group while the others see nothing, or wait on
  people and then reveal to members who never offered. Both split the one author set. So reveal
  policies stay `independent`, `voluntary` and `allReady`. `allReady` is already the
  all-participant rule, and its membership is already role-derived: everyone who holds the draft
  grant. Named and role rules apply only to approval, which decides who must consent before
  publication and never changes who reads what. Under `allReady`, a writer who cannot or will not
  offer is resolved by switching to `voluntary` or changing that person's role, and the Admin help
  text says so. Changing the reveal policy now must name the policy the coordinator read
  (`expectedPolicy`; 422 without it, 409 if it moved), so two coordinators cannot overwrite each
  other unseen. Like an approval rule change, a real reveal policy change clears every standing
  offer, so it also needs an explicit `confirmed` (422 without it), and resubmitting the current
  policy is a no-op that writes nothing.

## Consequences

- A non-writing author can approve only once they can read the whole piece (ADR 0021). Under
  today's reveal rules that needs a section of their own, so named or role rules mostly protect
  key writers ("the piece must not publish without Grace, even if Grace is removed") and require
  site owners or coordinators who also write.
- Editors cannot approve (ADR 0022), so a role rule on `editor` is refused while an editor-only
  author would be required. Readers are never authors and are not offered.
- No numeric quorum, voting, reputation or "winner" exists, as the issue's out-of-scope list asks.
