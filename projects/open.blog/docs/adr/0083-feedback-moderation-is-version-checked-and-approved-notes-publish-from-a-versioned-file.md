# ADR 0083: Feedback moderation is version-checked and audited, and approved notes publish from a versioned file through the public projection

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#83](https://github.com/journey-to-code-org/open.blog/issues/83)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0075](0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md),
  [ADR 0077](0077-targets-resolve-as-current-reanchored-or-stale.md),
  [ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md),
  [ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md),
  [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md),
  [ADR 0081](0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md),
  [ADR 0082](0082-passage-feedback-forms-are-one-progressive-region-over-the-build-passage-text.md)
- Amends: ADR 0080 (two columns, an audit table and one function in the unreleased
  `feedback.sql`), ADR 0081 (the moderation `PATCH` contract) and ADR 0075 (a feedback site
  publishes revision notes)
- Coordinates with: [#211](https://github.com/journey-to-code-org/open.blog/issues/211) (RD12.1
  moderation state machine), [#225](https://github.com/journey-to-code-org/open.blog/issues/225)
  (RD12.2 unified moderation inbox), [#208](https://github.com/journey-to-code-org/open.blog/issues/208)
  (RD6 correction decisions), [#124](https://github.com/journey-to-code-org/open.blog/issues/124)
  (P6.2 canonical-only fallbacks)

## Context

Readers can now send passage feedback to a hosted, pending queue (ADRs 0079 to 0082). #83
asks for the rest: moderators approve or reject it, authors respond, and a correction or
suggestion that led to a change gets a public revision note, with every action auditable and
conflict-safe, approval never editing the post, and nothing private reaching a public page.
Static builds must keep working without the hosted service, and a site's repository may be
public. RD12 (#211) defines one moderation state machine for every participation kind and #225
one inbox; both land after this task, so this one must be the smallest piece they can absorb, not
a second inbox. RD6 (#208) forbids calling a submission a correction before the author decides.

## Decision

- **States and actions are RD12's, as a subset.** `openblog_core::feedback_moderation` reads all
  six RD12 states (`pending`, `clarification`, `approved`, `rejected`, `removed`, `withdrawn`), so
  an item another tool moved is shown rather than misread, and offers three actions: approve
  (pending to approved), reject (pending or clarification to rejected) and remove (approved to
  removed). Reject and remove need a reason from RD12's decline codes (`spam`, `abusive`,
  `personal-data`, `off-topic`, `duplicate`, `rights`, `other`); approval takes none. No reason
  judges facts: there is no "incorrect". Every other combination is refused. The hosted function
  holds the same table (`netlify/lib/feedback-moderation.mjs`); both are checked against
  `tests/fixtures/feedback-moderation.json`. #225 can replace both without migrating data.
- **Every change is version-checked and audited in one statement.** The feedback table gains
  `version` (default 1) and `moderation_reason` (a reason code, never free text), and
  `feedback.sql` adds the insert-only table `openblog_feedback_events` (item, action, from, to,
  reason, actor, time, resulting version: a subset of RD12's audit event, never anything anyone
  wrote; the item's revision, its kind and the actor's role come in #225's additive migration)
  and the function `openblog_moderate_feedback`, which updates the row only while it still
  has the state and version the moderator saw, raises the version and inserts the event, in one
  SQL statement. `PATCH /admin/feedback` now takes `{id, action, from, expectedVersion, reason?,
  actor?}`; the function checks the change against the rules first, so a refused change costs no
  database request, and answers `409 conflict` with the item as it is now when the row moved, or
  `404 notFound`. `GET /admin/feedback` reads every RD12 state and one item by `id`. The actor is
  the Admin account name the proxy sends, or `@moderation-token`. These are additions to
  `feedback.sql`, which no released version has shipped; it stays additive and private, and the
  rollback drops exactly what it creates. No `delete` is granted.
- **Admin is the proxy and keeps the token.** Admin's `engagement/feedback` routes call the
  hosted routes server-side with the saved bearer token, which never reaches the browser. Every
  hosted item is read again with the shared validator (`HostedFeedback`, which now carries the
  version and reason); a bad item is counted and skipped. Each item is shown with its **passage
  check** against the post as published now: current, re-anchored or stale (with the reason), or
  "post not found", the reader's own quotation for the moderator, both revisions, and the public
  form it would take. Before approving, Admin reads the item again and checks its passage again:
  a changed state or version is a conflict, and a passage that is not current is approved only
  when the request names the very check the moderator confirmed. A moderator never acts on
  silently retargeted text. Every route is behind the session and CSRF seams and denies by
  default.
- **Approved notes publish from a versioned file.** Approving an item writes its public part to
  `reader-feedback.json` in the content folder (removing it takes it out), under the content lock,
  atomically, and rebuilds. The file holds, per note: the hosted id, the post's source path, the
  address and passage revision the reader saw, the target, the kind, text and details, the day
  received, the day approved, the reader's name only when they agreed to show it, and the
  author's response with its day. Never the reader's clock, a time of day, the channel, a private
  name or anything about moderation. It is deterministic (sorted, two-space JSON), refuses unknown
  fields, newer versions, traversal or non-post paths, bad days, text not in its stored form and
  repeated ids, naming the item and never repeating its text, and is versioned with the site, so
  a CI or static build publishes the same notes without the hosted service. A file that cannot be
  read refuses a full build (as broken claim evidence does) and Admin never writes over it; a
  note about a post that no longer exists is a warning. If the write fails after approval, the
  item stays approved and Admin offers "Publish on the post"; if it fails after a removal, the
  item stays removed, Admin says "Removed, but still on the post" and offers to take it off
  (`POST engagement/feedback/unpublish`, only for an item the hosted service holds as removed or
  rejected). Admin lists every state; clarification and withdrawn are read-only views, so an item
  another tool moved there is seen, and one waiting for clarification can still be rejected.
- **Responses are the author's own data.** `PUT engagement/feedback/response` sets or clears the
  public response to a published note. It names the file revision it loaded; any other revision
  is a conflict and nothing is written. A response sends nothing to the reader; no e-mail is
  collected or sent anywhere.
- **Revision notes reuse A4.** `POST engagement/feedback/revision-note` appends one
  `evidenceRevisions` item (`YYYY-MM-DD[ claim-id]: what changed`, ADR 0075) to the post's front
  matter, checked with the build's own rules with the whole list, every other field and the body
  kept. It never edits the post's text: accepting a suggestion is a separate edit. A site that
  opts in to passage feedback now publishes revision notes through the evidence section even
  without `claimEvidence.publish` (without reading any claims file); without either switch
  nothing changes. A note names a claim, a date and the change, and nothing about the reader.
- **Public output is the canonical page only, through the public projection.** A post's approved
  notes are read with `FeedbackProvenance::public` (ADR 0078) against the post as published now
  and rendered as a static "Reader questions and responses" section before the feedback form:
  the kind (a suggested correction keeps that label; nothing says "Correction"), a link to the
  section, the quotation only while the post still publishes it (otherwise a sentence says the
  post has changed), the text and details, "From" the consented name or "a reader", the day
  received and the revision seen, and the author's response. It says that publishing a note does
  not mean the author agrees. Everything is escaped; a suggested source is a plain link marked
  `nofollow ugc`. A hidden post shows none; a locked one keeps what was approved. Feeds,
  `llms.txt`, search and portable copies never carry the notes: the post gains the
  `passage-questions-and-corrections` capability, whose P6.2 fallback is the labelled canonical
  link "Questions and corrections".

## Consequences

- Approve, reject and remove are recorded in the hosted audit trail; responses and revision
  notes are recorded by the versioned files they change and Admin's log line.
- Two moderators can never both act on one item, and an approval is always of the text the
  moderator saw.
- RD12 can widen the actions (clarification, reopen, withdrawal, retention) on the same columns,
  and #225 can show these items in the unified inbox and take over the Admin view. (Amended by
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md) and
  [ADR 0106](0106-the-inbox-adds-columns-an-audit-table-and-conditional-functions-opt-in.md): the
  moderation inbox replaced the Reader feedback view and its `engagement/feedback` moderation
  routes, and the audit fields left for #225 were added to `feedback.sql`.)
- RD6 can add an author decision (accepted as a correction) to the published record without
  changing what is already stored.
  (Done by [ADR 0119](0119-the-authors-decision-is-published-with-an-approved-note-and-carried-into-portable-copies.md):
  the file is version 2 once it holds a decision, and portable copies carry each published
  suggestion's outcome, though still never the note's words.)

## Domain language

**Feedback moderation**, **Passage check**, **Published reader feedback** and **Author response**
are defined in [`CONTEXT.md`](../../CONTEXT.md).
