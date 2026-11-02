# ADR 0117: Only the author's correction decision labels a correction, and it links the item, the revision note and the claim evidence without erasing anything

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#208](https://github.com/journey-to-code-org/open.blog/issues/208)
- Parent story: [#199](https://github.com/journey-to-code-org/open.blog/issues/199)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0068](0068-claims-and-evidence-links-record-the-authors-reading.md),
  [ADR 0075](0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md),
  [ADR 0077](0077-targets-resolve-as-current-reanchored-or-stale.md),
  [ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md),
  [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md),
  [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0103](0103-who-may-moderate-reader-participation.md),
  [ADR 0104](0104-retention-audit-events-and-abuse-reports-fail-closed.md),
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md),
  [ADR 0116](0116-evidence-submissions-are-suggested-sources-and-corrections-with-unverified-reader-evidence.md)
- Coordinates with: [#211](https://github.com/journey-to-code-org/open.blog/issues/211) and
  [#225](https://github.com/journey-to-code-org/open.blog/issues/225) (RD12 policy and inbox),
  [#217](https://github.com/journey-to-code-org/open.blog/issues/217),
  [#218](https://github.com/journey-to-code-org/open.blog/issues/218)
- Amended by: [ADR 0118](0118-evidence-and-correction-decisions-are-taken-opt-in-and-decided-in-the-inbox.md)
  (storage, the inbox's "Record decision" and its checks)
- Contract: `openblog_core::correction_decision`, fixtures in
  `tests/fixtures/evidence-corrections.json` (`decisions`)

## Context

B5 deliberately never calls a suggested correction a correction (ADR 0079) and its moderation only
decides whether a reader's note is shown (ADR 0083). RD6 needs the other half: the author's own
decision about what a suggestion meant for the work, linked to the public revision note that says
what changed (`evidenceRevisions`, ADR 0075) and, where the author recorded the reader's source as
evidence, to that A4 link. #208's acceptance criteria are that a submission is never labelled a
correction before an author decision, that decisions never erase the original provenance, and that
no vote or popularity field implies accuracy; its fixtures must cover duplicate, withdrawn,
conflicting, accepted, declined, partially applied and stale-target submissions. RD12 (#211, ADRs
0101 to 0108) defines the one participation registry, state machine, roles and inbox this slots
into, with the same ids.

## Decision

- **A decision is the author's, separate from moderation.** Moderation decides whether a reader's
  words are shown; a correction decision records what the author concluded about the work. Neither
  implies the other: approving a note is not agreeing with it, and deciding an item never approves,
  rejects or publishes it. A decision never edits a post, citation, claim or the Source Library; the
  author makes those changes with the existing tools and the decision points at them.
- **Five outcomes** (`DecisionOutcome`, stored ids):

  | Id | Label | Means | Needs |
  | --- | --- | --- | --- |
  | `accepted-as-correction` | Correction | the work was in error and the author changed it | `extent`, `revisionNote` |
  | `accepted-as-clarification` | Clarification | not an error, but unclear or incomplete; reworded or context added | `extent`, `revisionNote` |
  | `accepted-as-evidence` | Added as evidence | the author recorded the offered source as A4 evidence (any relation) without changing the claim's words | `extent`, `revisionNote`, `claimEvidence` |
  | `declined` | Declined by the author | considered, no change | `declineReason`, `rationale` |
  | `already-addressed` | Already addressed | the work already reflected it | `revisionNote` or `addressedBy` |

  Only `accepted-as-correction` makes anything a correction (`is_correction`). Accepting as
  evidence is distinct from clarifying so that recording a contradicting source never reads as
  rewording, and a clarification is distinct from a correction so that an author can improve a
  passage without conceding an error.
- **Partial application** is `extent: partial` on an accepted outcome, with a required rationale
  saying what was and was not applied; `full` needs none. Declined and already addressed have no
  extent.
- **Decline reasons are the author's grounds, never verdicts:** `maintains-reading` (the author
  keeps the passage as written), `outside-scope`, `source-unavailable` (the author could not consult
  the source) and `other`, always with the author's rationale. There is no "incorrect", "false",
  "misinformation" or "unreliable source". Moderation grounds (spam, abuse, personal data,
  duplicates, rights) stay moderation reasons and are never decision reasons.
- **Links.** `revisionNote` is `{post, note}`: the post's source path and one `evidenceRevisions`
  item exactly as written, checked with the build's own rules (`revision_notes`); when the item's
  post is known the note must name that post, and the caller confirms the item is in its front
  matter with `RevisionLink::found_in` before recording. An accepted
  outcome's note must be dated no earlier than the day before the item was received (an older note
  means the work already addressed it: use `already-addressed`) and no note may be dated after the
  decision. The author writes local days and the receipt day is the UTC day, and UTC offsets span at
  most one calendar day either side, so one day before is the widest gap: a same-day correction
  written west of UTC is never refused. The decision's own day follows the same rule, and both
  comparisons are skipped when the stored receipt day is not a day (`is_day`).
  `claimEvidence` is `{claim, link}`, checked against the author's claims file
  (`ClaimEvidenceRef::check`); its claim must agree with a claim the note names. `addressedBy` is
  another item's id whose decision in force (for that item's current text revision, so an
  acceptance a clarification has since replaced does not count) is accepted; an item is never
  addressed by itself.
- **The record** (`CorrectionDecision`, version 1, unknown fields refused):
  `{version, item, sequence, outcome, extent?, declineReason?, rationale?, revisionNote?,
  claimEvidence?, addressedBy?, itemRevision, passageRevision?, passageCheck, decided,
  decidedBy: {role, account?}}`. `passageRevision` is the post's passage revision when the author
  decided (absent only when no post had the item's address) and `passageCheck` the check the author
  confirmed (`current`, `reanchored`, `stale:<reason>` or `unknown-work`). It holds nothing the
  reader wrote and nothing about the reader: no name, attribution, clock, channel or text.
- **Provenance is never erased.** The decision refers to the item by id; the item's record and its
  ADR 0078 provenance (the revision the reader saw, the target, when it arrived, the attribution
  choice) are not inputs that a decision could change, and the author's passage revision is kept
  beside, never over, the reader's. Each item has an append-only `DecisionLog` numbered from 1: a
  new decision names how many it saw (`expectedDecisions`, anything else is `stale`, so two authors
  never both decide on one view), is dated no earlier than the last, and supersedes it without
  removing it. A decision's revision note stays in the post's front matter even when the decision
  is superseded, as ADR 0075 already keeps every note.
- **Who decides.** Only the site Admin and a coordinator of the work's shared publication
  (`moderation::may_decide`), resolved by the server, never claimed by a request; contributing
  authors, the submitter, the public and the retention job never decide. The Admin account is kept
  only in the private record.
- **What can be decided.** Only evidence submissions (ADR 0116), while their moderation state is
  `pending` or `approved` and their current text is not the one a clarification asked about.
  Waiting for clarification is `awaitingClarification`; rejected, removed and withdrawn are
  `itemClosed`, and a decision recorded before a withdrawal stays in the log. A passage that is not
  current needs the author to confirm the exact check they read (`checkNotConfirmed` otherwise),
  as ADR 0083 asks of moderators, so nobody decides about text that silently moved.
- **Checks run in a fixed order**, the grant first so an actor who may not decide learns nothing:
  grant, kind, state, clarification, decisions seen, passage check, the outcome's fields (extent,
  reason, rationale, revision note, claim evidence, addressed by), then agreement with the post,
  the days and the addressing item. Errors (`DecisionErrorCode`) name fields and never repeat
  anyone's text; any error changes nothing.
- **Item standing** is how readers and editors tell items apart, and depends only on the kind, the
  evidence block and the decision in force: `question` and `alternative-interpretation` (never
  decided), then for an evidence submission without a decision `proposed-source`,
  `challenged-citation` (the block names an evidence link or a citation) or `possible-error`
  (labelled "Suggested correction", B5's label), and once decided the outcome's id. A decision made
  on an earlier text revision (a clarification replaced the text since, RD12) is kept but not in
  force, so the item stands undecided until the author decides again. Nothing reads a count, a
  moderation outcome or anything automatic.
- **Public form.** `PublicDecision` is the outcome, its label, extent, decline reason, rationale,
  the parsed revision note (its claim only while that claim is published, as ADR 0075 does), the
  claim evidence link only while it is published, the day decided and how many decisions it
  superseded. Never who decided or anything about the reader. It is produced only while the
  reader's item is itself public (approved at its current revision and shown on the post); a
  pending, rejected, removed or withdrawn item's decision is never linked to it in public, because
  that would reveal a submission the reader or moderation kept private. The post's revision note
  remains public on its own, as before, and names no reader. Reader attribution stays ADR 0078's:
  a name appears only through the item's own public form and only with consent.
- **Scope of this task.** Pure Rust types, validation and fixtures. Storage, routes, the Admin
  review and pages are #217 and #218: a decision log is meant to be stored privately with the
  hosted item (an additive change, #217's one-way door), and its public form copied into the
  versioned published-feedback file only for published items (#218).

### How this maps onto RD12

This was written before RD12 merged, with RD12's ids, so the merge renamed nothing. It now applies
as follows:

- **Kinds.** Evidence submissions are RD12's `source-suggestion` and `correction-suggestion` rows
  (`ParticipationKind`), whose rules (reader origin, passage target, publishable, may ask to
  clarify, per post) already fit. No registry row is added; `is_evidence_kind` is a match on those
  two `ParticipationKind` variants. An author response stays RD12's `author-response` kind; a
  decision is not a participation kind, because nobody submits it for moderation.
- **States.** `DecisionFacts` carries RD12's `ItemFacts`, with its `ModerationState`, beside the
  receipt day, the post and the passage check. Decidable means `pending` or `approved` and not
  `ItemFacts::current_revision_asked()`; the decision's `itemRevision` is `ItemFacts::revision`.
  A decision is not a `ModerationAction` and never changes the state, version or
  `approved_revision`.
- **Roles.** The decider is RD12's `Actor`, taken from `SharedWorks::actor(principal, work,
  identities)` as RD12 resolves every other action, and recorded by its `ActorRole` id. The grant
  (`moderation::may_decide`) is the approve row of ADR 0103's table: the site Admin and a
  coordinator of the item's work. Contributing authors keep the right RD12 gives them to write an
  `author-response`. The private record keeps `Actor::account`, `@moderation-token` for the
  hosted token.
- **Reasons.** `DeclineReason` ids never coincide with a moderation meaning in RD12's
  `ReasonCode`; the only shared spelling, `other`, lives in a different field (`declineReason`
  against moderation's `reason`).
- **Audit.** The decision log is its own private, append-only record of who decided what and when.
  Recording a decision also writes an RD12 `AuditEvent` (`correction_decision::audit_event`) with
  the additive `AuditAction::Decide` (id `decide`, `from` and `to` both the item's unchanged
  state, no reason, the item's revision and version), so the inbox's trail shows decisions beside
  moderation; retention purging an item's text leaves its decisions, which hold none of it.
- **Inbox.** RD12's inbox (ADR 0105) offers "Record decision" (`Inbox::may_record_decision`) only
  where `decide` would accept the actor, kind and state and the hosted service stores decisions,
  as it already does for moderation actions, and beside them, never instead of them.

## Considered options

- **Make "correction" a moderation state or action.** Rejected: it would tie what the author
  concluded to whether a note is shown, and a declined suggestion would read as a rejected note.
- **A single "accepted" outcome.** Rejected: readers could not tell an admitted error from a
  clarification or from new evidence, which is the user benefit #208 asks for.
- **Overwrite a decision when the author changes their mind.** Rejected: the history of a
  correction is part of its provenance.
- **Publish a decision about a private item.** Rejected for now: it would reveal a submission its
  reader withdrew or moderation kept back. The revision note already says what changed.

## Consequences

- A suggestion can only become a correction through `decide` with an author role, an accepted
  outcome and a revision note; every public "Correction" label can be traced to that record.
- #217 adds the decision form and storage to the review and inbox; #218 renders `PublicDecision`
  next to published notes and carries outcomes into portable copies through the canonical link.
- Fixtures for every scenario #208 lists (duplicate, withdrawn, conflicting, accepted, declined,
  partially applied, stale target) are shared JSON, ready for a JavaScript reader if one is needed.

## Domain language

**Correction decision**, **Decision outcome**, **Decision log**, **Item standing** and **Public
decision** are defined in [`CONTEXT.md`](../../CONTEXT.md).
