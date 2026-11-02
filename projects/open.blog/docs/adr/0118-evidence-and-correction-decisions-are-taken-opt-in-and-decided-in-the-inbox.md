# ADR 0118: Evidence is offered from published lists and stored opt in with the item, and correction decisions are recorded from the inbox, checked three times and audited

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#217](https://github.com/journey-to-code-org/open.blog/issues/217)
- Parent story: [#199](https://github.com/journey-to-code-org/open.blog/issues/199)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md),
  [ADR 0081](0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md),
  [ADR 0082](0082-passage-feedback-forms-are-one-progressive-region-over-the-build-passage-text.md),
  [ADR 0103](0103-who-may-moderate-reader-participation.md),
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md),
  [ADR 0106](0106-the-inbox-adds-columns-an-audit-table-and-conditional-functions-opt-in.md),
  [ADR 0116](0116-evidence-submissions-are-suggested-sources-and-corrections-with-unverified-reader-evidence.md),
  [ADR 0117](0117-only-the-authors-correction-decision-labels-a-correction.md)
- Coordinates with: [#218](https://github.com/journey-to-code-org/open.blog/issues/218) (published
  outcomes)
- Amended by: [ADR 0119](0119-the-authors-decision-is-published-with-an-approved-note-and-carried-into-portable-copies.md)
  (the decision request names the text revision, the evidence bound, evidence off, the rollback)

## Context

ADRs 0116 and 0117 defined the evidence block and the correction decision as pure types. #217
carries them through the reader form, the hosted function and the moderation inbox: readers submit
structured evidence safely, and editors compare it with the claim or citation it targets before
deciding. Its acceptance criteria are that the hosted service stays optional, that rate limits and
bounds apply before anything is stored, and that a decision cannot change an article, a citation or
the Source Library without a separate author action. Hosted storage is a one-way door, so the
schema must be additive, opt in and reversible, and a reader's guess at an id must never confirm
that something private exists.

## Decision

- **The form offers only published choices.** With `engagement.evidence` on in `openblog.json`
  (off by default, left out of the file while off), a post that is open to a suggested source or
  correction carries an `evidence` attribute on its feedback region and a page data element
  (`ob-evidence-references`) built by `evidence_submission::reference_choices` from public output
  only: the post's published claims with their published evidence links, the sources the post
  publishes, and the sources the site's published posts publish, each `{id, label}`. Drafts publish
  nothing. The form shows an optional "Evidence" fieldset for those two kinds only: a claim, the
  evidence link on it the reader questions, a cited source the reader questions, a source the site
  publishes that they offer with one locator, and a stance radio group whose first choice is "I am
  not saying". Readers never type an id, so nothing they enter can probe for a private one. Naming
  nothing sends B5's version 1 exactly as before; naming anything sends version 2.
- **One validator, three readers.** `readEvidenceSubmissionJson` in
  `web/components/passage-feedback.js` reads version 2 as `EvidenceSubmission` does, with the same
  codes in the same order (a B5 rule's refusal is `feedback` with B5's code), against the shared
  `submissions` fixtures. `readSubmissionJson(text, {evidence})` is what the form and the hosted
  function call: with evidence on, version 2 and newer go to the evidence reader and everything
  else to B5's; with it off, everything goes to B5's, which refuses version 2.
- **Hosted transport is opt in and checks before it stores.** `OPENBLOG_CORRECTIONS_ENABLED=true`
  (with feedback and the inbox's schema) tells the function the schema is there. `POST /feedback`
  then validates the whole submission, evidence included, before the quota, takes the quota before
  storing, and stores the block in its own column as a pending version 2 row; the hourly replay
  digest includes the block. Without the variable a version 2 submission is refused with
  `unsupportedVersion`, and the form gives the reader the note to copy, evidence included, as for any
  other refusal. The function never says whether a named id exists; Admin alone resolves references,
  against public output.
- **The schema** (`supabase/feedback.sql`, run again; additive):
  - `openblog_feedback.evidence jsonb` (nullable, an object of at most 4 KiB) and a check
    `openblog_feedback_evidence_needs_version_2` (`evidence is null or format_version >= 2`);
  - `openblog_feedback.decisions jsonb` (nullable, an object of at most 1 MiB): the item's decision
    log `{version, item, decisions}`, private like the rest of the row;
  - the trigger `openblog_feedback_purge_evidence` (`before update`), which deletes the evidence
    block and returns the row to format version 1 whenever its text is purged, reading the row as
    JSON so it works with or without protection's `purged_at` column;
  - `openblog_record_feedback_decision(p_site_id, p_id, p_expected_decisions, p_item_revision,
    p_decision, p_actor, p_actor_role, p_at)`, which appends one decision and inserts a `decide`
    event into `openblog_feedback_events` (`from_status` and `to_status` both the unchanged state,
    no reason, the item's version, kind, text revision and the actor's role) in one statement, only
    while the item is a suggested source or correction, pending or approved, not the text a
    clarification asked about, at `p_item_revision`, holding exactly `p_expected_decisions`
    decisions (fewer than 100), decided by `site-admin` or `coordinator`, and the decision names the
    item, the next sequence, that text revision and that role. It changes nothing else.

  `supabase/corrections-rollback.sql` drops exactly these, after returning version 2 rows to
  version 1 (their evidence goes with the column; their note, kind and state stay) and keeping the
  `decide` audit events. `feedback-rollback.sql` drops the function and trigger with the table.
- **The inbox shows evidence for comparison and cues duplicates without counting.** Each feedback
  item's view carries its standing (ADR 0117: the reader's intent, never a correction before the
  author decides), its evidence reviewed by `evidence_review` (each named reference published or
  not on the post, or for the offered source on the site, with the public label of a published one,
  and for a published claim its words and published evidence links, so the editor can compare;
  "not published" never says private or mistyped), and its decision log with the decision in force.
  Items on one page that point at the same passage or name the same claim, evidence link, source or
  source link are listed on each other's cards as "possibly about the same thing", with links,
  never as a number, and each is decided on its own.
- **"Record decision" is offered where the policy allows and the store can keep it**
  (`Inbox::may_record_decision`), beside moderation and never instead of it: to the site Admin and
  the work's coordinator, on a pending or approved suggestion whose text is kept and was not asked
  about, when the hosted item carries a decision log. The form lists the outcomes with what each
  needs, extent, decline reasons, a rationale, the post's `evidenceRevisions` items exactly as
  written (read by Admin from the post file), the evidence links the claims file records on the
  post's claims, the item that addressed it, the passage confirmation when the passage moved, and
  the author's local day. The revision note and the evidence link are recorded first, with
  Admin's existing revision-note step and Evidence Studio; the decision only points at them, so it
  never edits the post, a citation or the Source Library.
- **Every decision is decided three times and written once.** `POST
  engagement/moderation/decision` reads the request strictly, refuses a day more than one day after
  the server's UTC day, re-reads the item (and the item it was addressed by, only on the same post),
  decides with `Inbox::record_decision` (RD12's actor on the item's work, ADR 0117's rules), checks
  that the post's front matter holds the note and that the claims file has the link on one of the
  post's claims, and sends the decision with the account and role to `POST /admin/decisions`. The
  function checks it again from the stored row (`netlify/lib/correction-decisions.mjs`, held to the
  Rust policy by the `decisions` fixture cases) and the statement above applies it. A refusal is
  `403 denied`, a stale view `409` with the item as it is now, anything else `422` with the
  policy's code. Nothing is e-mailed to anyone, and the reader's note is neither published nor
  hidden by a decision.
- **Accessible by construction.** The evidence fieldset and the decision form are native, labelled
  controls in fieldsets with legends; each outcome's guidance is its description; a missing or
  refused field is announced and takes focus; the stance and outcome groups move with the arrow
  keys; the decision form is a disclosure; and both fit 320px.

## Considered options

- **Let readers type ids.** Rejected: a free id field invites guessing, and an answer that differs
  for a private id would confirm it.
- **Store evidence inside `details`.** Rejected: an older function would send it back inside B5's
  details, and a purge already clears details only by convention; a column with its own check and
  purge trigger keeps the reader's statement separate and removable.
- **Record a revision note as part of the decision.** Rejected: the acceptance criterion asks for a
  separate author action, and a note is public; the inbox offers adding one as its own step.
- **Raise the item's version on a decision.** Rejected: a decision is not moderation (ADR 0117);
  the log's length is the decision's own concurrency check, and the text revision guards against a
  clarification arriving in between.

## Consequences

- A site that changes nothing builds, submits and moderates exactly as before. Running
  `feedback.sql` again and setting the variable and `engagement.evidence` enables the whole flow.
- #218 can publish the decision in force for published items from the stored log, through
  `public_decision`.
- The stored decision log and the `decide` events outlive a purge of the reader's text, holding
  nothing the reader wrote.

## Domain language

**Evidence choices**, **Duplicate cue** and **Record decision** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
