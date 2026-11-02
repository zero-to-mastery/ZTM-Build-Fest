# ADR 0020: Approval snapshots bound to exact content, with defined invalidation and consent

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#166](https://github.com/journey-to-code-org/open.blog/issues/166)
- Parent story: [#147](https://github.com/journey-to-code-org/open.blog/issues/147)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0014](0014-record-level-authorization-and-publish-gate.md) refuses publishing until every
contributing participant approved "the contract's current revision", but that is one number for the
whole contract: it says nothing about which prose, order, metadata, author set or policy a person
agreed to, and any change either leaves approvals standing or has to remember to clear them.
[ADR 0018](0018-reveal-policy-readiness-and-comparison.md) fixed that a publication has one author
set, the participants the maintainer added.

## Decision

- An approval is a stored snapshot of `participant`, `approvedAt`, `consentVersion` and a
  `binding`: a digest of exactly what the approval covers. It holds no prose, names, or revision
  digests. The binding covers the consent wording version, the approval policy and its revision,
  the participant, the sorted author set, the public metadata (title, guiding question, original
  source title, link and type; private source fields are excluded), the order and ownership of
  sections, and the prose revisions the scope covers.
- Validity is recomputed, never flagged. An approval counts only while the binding recomputed from
  the content as it is now equals the stored one, so a change no one thought to hook still fails
  closed. `ApprovalSet::reconcile` also drops stale approvals durably; routes call it in the same
  write as any change to prose, order, metadata or the author set, so removing and restoring an
  author, or reverting an edit, cannot revive consent given earlier.
- What invalidates which approvals is defined by policy scope. Under `ownSections` (default) a
  prose edit invalidates only its owner's approval. Under `wholePiece` any prose edit invalidates
  every approval. An author who owns no section has no prose of their own to scope to, so under
  `ownSections` their approval covers every section: any prose edit invalidates it. Under both, any change to the author set, section order or ownership, public
  metadata, policy, or consent wording invalidates every approval. A policy change also clears all
  approvals and advances the policy revision.
- Required approvers come from the policy: `allAuthors` (default) needs every author the
  maintainer added, `contributingAuthors` only authors who own a section. Pending, revoked,
  expired or removed people are not authors and never count.
- Consent is affirmative and attributable. Approving needs an explicit affirmation and the
  `seen` binding the approver read, so it covers what they saw (a stale view is refused, nothing
  changes). The requester must equal the participant and be a current author: no role, including
  site owner and coordinator, can approve for another or withdraw another's approval, and every
  such refusal is the same `Denied`. A publish grant never substitutes for approval. The site
  owner may change the policy, which can only remove approvals, never add one. (Amended by
  [ADR 0052](0052-group-approval-rules-add-approvers-and-never-split-the-reveal.md): a
  coordinator may change it too, but only in ways that keep or add required approvers. A change
  that drops anyone the current rule requires still needs a site owner.)
- `ApprovalSet::evaluate` is the gate's question, asked at publish time against current content.
  A scheduled publication is therefore re-checked when it fires: time never expires or renews an
  approval, but an edit between scheduling and publishing blocks it. An invalid subject (no
  authors or sections, a section whose owner is not an author, duplicate ids) is an error and never
  ready. Stored sets are size-limited, strictly typed, and unknown fields fail to load.
- This is consent to publish this content as stated, not an electronic signature or legal
  agreement.

## Consequences

- Core types and validation land here (`approval` module). Later work stores the set in private
  project storage, routes approve/withdraw/policy through `SharedPublication::authorize`
  (`ApproveContribution`, own participant only), builds the subject from the revealed or
  assembled draft revisions, calls `reconcile` in each write, and runs `evaluate` in the publish
  transaction. Until then `authorize_publish` keeps its ADR 0014 check.
- Unapproved prose reaches no public page, feed, export or log: the set carries none.
