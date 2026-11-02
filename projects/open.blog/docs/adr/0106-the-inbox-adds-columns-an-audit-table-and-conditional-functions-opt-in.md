# ADR 0106: The inbox's hosted schema adds columns, a comment audit table and conditional moderation functions, opt in

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#225](https://github.com/journey-to-code-org/open.blog/issues/225)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md),
  [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md)
- Amends: ADR 0102 (comments keep their `status` column and gain the full state beside it now,
  not with #226), ADR 0083 (the audit fields it left for #225)
- Coordinates with: [#226](https://github.com/journey-to-code-org/open.blog/issues/226)

## Context

The one state machine needs, for every item, its version, its text's revision, the revision an
approval covers, the revision a clarification asked about, and the reader's consent to be asked.
Comments have none of these, and their `status` column holds only `pending`, `approved` and
`rejected`, which public reads use. B5's feedback table has a version but not the revisions, and
its audit table left the item's kind, revision and the actor's role to #225. Hosted storage is a
one-way door: every change must be additive, opt in and reversible without making anything
private public.

## Decision

- **Additive only.** Nothing is renamed, dropped, retyped or rewritten. Every new column has a
  default or is nullable, so every row already stored reads as before.
- **Comments** (`supabase/moderation.sql`, new and optional):
  - `openblog_comments` gains `version integer not null default 1`, `moderation_state text`
    (nullable: a comment no inbox decision touched has the state its `status` says) and
    `moderation_reason text` (a reason code, never free text).
  - `status` keeps its three values and stays what public reads use. Every decision writes the
    full state to `moderation_state` and its ADR 0102 legacy value to `status` in the same
    statement: removed is stored as `rejected`, so nothing that is not public is ever stored as
    approved.
  - The `openblog_comment_events` audit table (comment, action, states, reason, actor, actor
    role, time, version; never text or a name), private like ADR 0080's tables. Its rows are only
    inserted here; engagement protection
    ([ADR 0108](0108-retention-runs-from-a-dry-run-and-quotas-keep-only-hourly-digests.md)) later
    lets the retention run delete events older than the site's audit period, and a trigger
    refuses to delete any recorded in the last day.
  - `openblog_moderate_comment(...)` applies one decision only while the comment still has the
    state and version both Admin and the function saw,
    raises the version and inserts the event, in one statement, writing only a comment's four
    states.
- **Passage feedback** (`supabase/feedback.sql`, run again to add them):
  - `openblog_feedback` gains `item_revision integer not null default 1`, `approved_revision`,
    `clarification_asked` and `clarification_consent boolean not null default false`. (Its
    `revision` column is the passage revision a reader saw, ADR 0078, so the text's revision is
    `item_revision`.)
  - `openblog_feedback_events` gains the nullable `kind`, `item_revision` and `actor_role` ADR 0083
    left for this task; older events keep none.
  - `openblog_moderate_feedback_item(...)` applies one decision conditionally on state and version,
    sets the revisions as the state machine does, and inserts the full event. It also refuses in
    SQL what must never happen whatever its caller says: approving the text a clarification asked
    about, reopening it to anything but clarification, and asking a reader who did not consent. A
    submitter's clarification (`p_body`) replaces the text as the next revision; no route offers
    it until reader receipts exist (#226).
- **`status` decides when the two columns disagree.** A comment's state is its
  `moderation_state` only while `status` still holds that state's legacy value; otherwise it is
  its `status`. A decision taken while the variable was unset writes `status` alone, so after the
  variable is set again a comment approved, reopened or rejected in between reads as what its
  `status` says, never as the stale full state (a comment removed and then reopened without the
  schema is pending, not removed). The function's reads, the inbox's state filters and
  `openblog_moderate_comment`'s condition all apply this one rule (`commentState` and
  `commentStateFilter` in `netlify/lib/participation-moderation.mjs`).
- **Opt in, with the older schema still served.** `OPENBLOG_MODERATION_ENABLED=true` tells the
  function the schema is there. Without it, the inbox still lists comments and feedback and offers
  only what the older schema can store: comments are approved, rejected, removed (stored as
  rejected) and reopened with a write conditional on their `status`, and feedback uses B5's
  `openblog_moderate_feedback`; asking to clarify and reopening feedback answer that the schema is
  needed. With it, the older bare comment `PATCH /admin/comments` is refused, because it would
  skip the version, the state and the audit event; B5's `PATCH /admin/feedback` goes through the
  new function. B5's `/admin/feedback` answers keep v0.33.0's shape exactly, with or without the
  variable, because an Admin of that version refuses any field it does not know; only the
  inbox's `/admin/moderation` items carry the revisions and the reader's consent.
- **Rollback drops exactly what was added.** `supabase/moderation-rollback.sql` drops the comment
  function, `openblog_comment_events`, the three comment columns, the feedback function and the
  feedback columns this task added, leaving every comment and feedback item and its state; a
  removed comment's `status` is already `rejected`. `supabase/feedback-rollback.sql` drops both
  feedback functions with its tables. Unsetting the variable first returns the function to the
  older schema.

## Considered options

- **Widen `openblog_comments.status`.** Rejected: it would change what public reads see for any
  older function still deployed, and is not additive.
- **Store comment events in `openblog_feedback_events`.** Rejected: its `feedback_id` is a
  required reference to the feedback table, and relaxing it is not additive.
- **Trust the caller's revisions in SQL.** Rejected: the statement computes them from the row it
  updates, and refuses the clarification rule's violations itself.

## Consequences

- A site that runs nothing new keeps comments and feedback working, with the older schema's
  decisions; running the files and setting the variable enables every inbox decision.
- #226 adds retention, abuse reports and reader receipts on these columns without another
  migration for the facts the state machine needs.
