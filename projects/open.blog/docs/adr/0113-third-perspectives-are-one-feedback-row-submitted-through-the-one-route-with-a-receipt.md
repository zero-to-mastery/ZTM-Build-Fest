# ADR 0113: Third Perspectives are one feedback row, submitted through the one route with a receipt, and approved at the consent the moderator saw

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#221](https://github.com/journey-to-code-org/open.blog/issues/221)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md),
  [ADR 0081](0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md),
  [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md),
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md),
  [ADR 0106](0106-the-inbox-adds-columns-an-audit-table-and-conditional-functions-opt-in.md),
  [ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md),
  [ADR 0110](0110-submission-consent-is-an-append-only-record-and-anonymous-display-keeps-provenance.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0112](0112-third-perspective-shapes-map-onto-b5-and-rd12-at-merge.md)
- Coordinates with: [#222](https://github.com/journey-to-code-org/open.blog/issues/222) (status
  and the canonical page's rendering), [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
  (featured reflections)

## Context

ADRs 0109 to 0112 define what a Third Perspective is and how its consent and lifecycle work, with
storage left as a one-way door. #221 opens it: readers submit without an account where the
optional service is configured, the submission always enters pending, and moderators decide in
RD12's one inbox. B5 already has one private feedback table whose `kind` and `status` check only
their shape, one transport route, a shared browser and function validator, and the copy-and-send
fallback; RD12 has one policy seam, receipts, the inbox, retention and abuse reports.

## Decision

- **One route, one store.** A Third Perspective is sent to the hosted function's existing
  `POST /feedback`. The function routes it by its `kind` to its own reader,
  `readThirdPerspectiveSubmissionJson` (`web/components/third-perspective.js`), which applies
  `SubmissionRequest::from_json` and `receive`'s checks in the same order; both are held to
  `tests/fixtures/third-perspective-submissions.json`. It is then gated exactly like passage
  feedback: the post's mode for the kind from `openblog-participation.json` must be `open`
  (ADR 0101), the hourly `feedback` quota and replay bound apply (`409 duplicate`), and it is
  stored as `pending`, never anything else. No rank, rating, vote or score exists anywhere in the
  submission, the row or the inbox.
- **Storage (the exact schema).** One `openblog_feedback` row per copy: `kind` =
  `third-perspective`; `format_version` 1; `work`, `revision`, `target`, `seen_at`,
  `received_at`, `channel`, `reader_name` and `publish_name` from the provenance as received (B5's
  record, ADR 0078); `body` the current text; `item_revision` its revision; `status` RD12's state;
  `clarification_consent` the consent in effect's clarification; `receipt_hash` the receipt's
  digest. `details` = `{"category"?, "intake": {"receiptDigest"}, "consents": [...], "revisedAt"?}`
  (`SubmittedCopy::stored_details`; `SubmittedCopy::from_stored` reads a row back with every
  rule). The only schema change is additive and opt in, in `supabase/feedback.sql`:
  - `alter table public.openblog_feedback add column if not exists approved_consent integer check (approved_consent >= 1);`
  - `create or replace function public.openblog_moderate_third_perspective(text, uuid, integer, text, text, text, text, text, text, timestamptz, integer)`,
    which takes every inbox decision on a row of this kind while its state, version and text are
    as both Admin and the function saw them, sets `approved_revision` and `approved_consent` only
    on approval, refuses what `openblog_moderate_feedback_item` refuses, and refuses an approval
    unless the consent record it names is the last one and still agrees to publish
    (`details->'consents'->-1`). It records the same audit event.

  `supabase/third-perspective-rollback.sql` drops exactly those two; `feedback-rollback.sql` drops
  the function with the table, and the moderation and protection rollbacks say to run it first.
- **Opt in, and only with receipts.** The function takes Third Perspectives only with
  `OPENBLOG_THIRD_PERSPECTIVES_ENABLED=true` on top of passage feedback, the inbox's schema and
  protection, because every hosted copy must have a receipt (its `Intake::Hosted` digest), the
  only proof that lets the reader take it back. Without it the route answers `404 unavailable`
  and the reader gets the copy-and-send path. Pages offer the hosted form only with
  `engagement.receipts` (ADR 0114).
- **Receipts are RD12's.** `POST /receipt` works as for every reader kind, with these differences
  for this kind: `read` returns the category only, never the consent records or the digest;
  `consent` (agreeing or declining to be asked, while pending) appends a consent record as
  `SubmittedCopy::revise_consent` would (`reviseClarificationConsent`, held to the same fixture)
  and raises the row's version, so an approval made on the earlier record is refused; `clarify`
  replaces only the text and adds `revisedAt`, keeping the category, intake and consent records
  whatever the reader sends; `withdraw` is RD12's withdrawal and purge, which is the revocation of
  ADR 0112.
- **Moderation is RD12's inbox.** The function lists rows of this kind with the inbox's facts and
  `approvedConsent`, and B5's own `/admin/feedback` lists only B5's kinds and refuses to decide a
  Third Perspective (`409 useModerationInbox`). Admin reads each row back into a
  `HostedPerspective` (`moderation_inbox::Content::Perspective`), decides with RD12's policy, and
  before an approval calls `Inbox::check_perspective_approval` (`SubmittedCopy::check_approval`
  with the signed-in account as the moderator) for the text revision and consent record the card
  showed, which the request carries as `seenRevision` and `seenConsent`. The function checks them
  again (`checkThirdPerspectiveApproval`), and the database a third time. An approval is offered
  only where the page says the service records it (`thirdPerspectives` in the inbox page). The
  view shows the category, what it is about and whether that section changed, the consent in
  effect, the credit-name hint and how it would read; the reader's name follows RD12's rules, and
  the receipt's digest is never shown. Approving publishes nothing yet: the canonical page renders
  approved responses in #222, and nothing is written to `reader-feedback.json`.
- **Nothing is e-mailed**, and nothing identifies a reader beyond what they chose to give.

## Considered options

- **A separate route and table.** Rejected: B5 and RD12 deliberately made one store and one
  route for every reader kind; a second would duplicate quotas, receipts, retention and reports.
- **Hosted copies without receipts.** Rejected: ADR 0110 promises the reader can take it back at
  any time, and only a receipt proves the submitter; without one the conservative path is the
  copy to the author.
- **Binding the approval by the version alone.** Rejected as the only guard: the version does
  bind it (consent changes raise it), but storing `approved_consent` is what lets the page later
  require that the approved and current consent agree (ADR 0111), and lets the database refuse an
  approval of a revoked or superseded consent outright.
- **Keeping the receipt's digest only in `receipt_hash`.** Rejected: the record's intake is part
  of the checked copy (ADR 0110); the duplicate is a one-way digest of a random secret, never
  returned to the reader or shown in the inbox.

## Consequences

- A site turns Third Perspectives on in three steps (SQL, environment, `participation.kinds`) and
  off by removing the environment variable; rows stay and stay private.
- #222 renders approved responses from the hosted rows with `approved_response`, using
  `approved_consent`; until then an approved reflection is shown nowhere.
- Retention, deletion requests and abuse reports treat these rows like every reader kind.

## Domain language

**Third Perspective region** and **Perspective consent record** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
