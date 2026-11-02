# ADR 0107: Readers hold private receipts, deletion requests keep only the record, and abuse reports are anonymous and upheld with the item they name

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#226](https://github.com/journey-to-code-org/open.blog/issues/226)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0104](0104-retention-audit-events-and-abuse-reports-fail-closed.md),
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md),
  [ADR 0106](0106-the-inbox-adds-columns-an-audit-table-and-conditional-functions-opt-in.md)
- Coordinates with: [ADR 0108](0108-retention-runs-from-a-dry-run-and-quotas-keep-only-hourly-digests.md)
  (the schema and retention job), [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
  (RD14 consent and withdrawal)

## Context

ADR 0102 lets a submitter answer a clarification request and withdraw an item, and ADR 0104 says a
withdrawn item's text is purged at once and that abuse reports fail closed, but nothing yet lets a
reader prove they are the submitter, stores a report, or deletes anything. #226 asks for consent
withdrawal, abuse reports, public removal behaviour and deletion, with no raw address, user agent
or cross-day identifier stored and nothing e-mailed. Readers have no accounts.

## Decision

- **A receipt is the only proof of submission.** When the hosted function takes a note of a kind
  that may be asked to clarify (`moderation::issues_receipts`: the four passage kinds and Third
  Perspectives), it creates 32 random bytes, returns them once as a 43-character base64url
  `receipt` in the `202` answer and stores only their SHA-256 digest (`receipt_hash`). Comments
  predate receipts, abuse reports are anonymous, and authors act through Admin, so none of those
  gets one. The page shows the receipt once, with a copy button, and keeps nothing in the browser.
  Losing it loses access; nothing identifies the reader to recover it.
- **What a receipt does** (`POST /receipt`, origin-checked, its own hourly quota, every miss the
  same `404 unknownReceipt`): read the note (its state, the reader's own words until purged,
  whether and why a clarification was asked, never a moderator's identity or a rejection reason);
  agree or decline to be asked to clarify while the note is pending (clarification consent is
  recorded through the receipt right after submission rather than in the submission format,
  which stays ADR 0079's); answer a clarification request (the answer is read with the shared
  submission validator for the same passage and stored as the next revision by
  `openblog_moderate_feedback_item`, ADR 0106); or withdraw it. Every change names the version
  it saw; a stale view is `409` with the note as it is now.
- **A deletion request keeps only the record** (`ModerationPolicy::erase`, `Erasure`):
  - By receipt, for any of the submitter's notes: one pending, waiting or approved is withdrawn
    first, in the same statement, so it is never public again; a rejected or removed one is
    purged as it is. Withdrawing is therefore always a deletion, as ADR 0104 already required.
  - By the site Admin, for a reader who asked some other way, on an item already closed
    (rejected, removed, withdrawn) or an upheld report. An open or public item is decided first
    (rejected or removed with `personal-data`), so no deletion skips a moderation decision. This
    is how a commenter's request is honoured: it purges one comment the Admin chose, and is not
    the retention job, which never touches comments unless the site opted them in (ADR 0104).
    Coordinators and contributing authors cannot delete.
  - Purging overwrites the text, details and reader name with a fixed placeholder that is never
    shown, sets `purged_at` and raises the version, and records a `purge-content` audit event
    without text (`withdraw` first when the reader withdrew). The row stays, so its state and
    audit trail remain explainable; a purged item takes no further decision (`contentPurged`),
    and the database refuses ever to approve it (a check constraint).
  - A withdrawn note that was published stays in `reader-feedback.json` until Admin takes it off:
    the hosted function cannot change the site's files. The inbox shows it as "withdrawn, but
    still on the post" with the existing "Take it off the post" action, and an Admin deletion
    takes a published note off its post in the same request.
- **Abuse reports are stored, anonymous and fail closed** (`openblog_abuse_reports`): a report
  names the item (comment or passage feedback), its post, one ground from the upholding reasons
  (`moderation_inbox::report_grounds`: spam, abusive, personal data, off topic, rights, other)
  and at most 1,000 characters; never a name, contact, address or device detail. `POST /reports`
  takes one only while abuse reports are `open` on the post (`openblog-participation.json`) and
  the item is public now: an approved comment on a post that shows comments, or passage feedback
  approved at its current revision, not the text a clarification asked about, on a post that
  shows its kind. Anything else, including a purged or missing item, is the same
  `404 unavailable`. Reports per client and per item are bounded each hour, and the same report
  from the same client is taken once: beyond those bounds the reader is still told it was sent
  and nothing is stored, so floods neither fill the table nor learn the limits.
- **Reports join the inbox; upholding uses the item they name.** The function sends each report
  with a snapshot of its item (source, id, kind, state, version, revision, a comment's author
  name, the text unless purged; never a feedback reader's name). Admin reads it strictly
  (`InboxItem` `Source::Report`, `ReportedTarget`), and offers `uphold-report` only on reports,
  decided by `ModerationPolicy::decide` with that item. Admin sends the item's version it saw;
  the function decides again (`planUphold`) and `openblog_uphold_report` upholds in one
  transaction only while the item is exactly as Admin saw it: approved at that version, which it
  then removes with `upheld-report`, or out of public view, when only the report changes. Any
  other case is a conflict and changes nothing. Dismissing is `reject` with a dismissal reason.
  A removed passage note is taken off `reader-feedback.json` as a removal is (ADR 0083).
- **Readers see it only where the site turns it on.** `participation.kinds["abuse-report"] =
  "open"` adds a progressive `<ob-abuse-report>` to each published note (its static text says to
  write to the author) and a report form under each comment. `engagement.receipts: true`
  (written only when on) adds "Check, clarify or withdraw a note you sent" to the passage form.
  Both are labelled native controls with live status and moved focus; untrusted text stays text.
- **No reader is contacted.** Nothing here sends e-mail or any message to a reader.

## Considered options

- **Reader accounts or e-mailed links.** Rejected: an identifier the project promised not to
  keep, and e-mail the policy forbids.
- **Store the receipt itself.** Rejected: anyone reading the table could act as every reader.
- **Delete rows on request.** Rejected: audit events reference the row, and a deleted row leaves
  a decision unexplainable; purging the text keeps the record and nothing private.
- **Let a report hide its item or count publicly.** Rejected by ADR 0104: reporting would become
  a takedown or a popularity signal.

## Consequences

- A reader can see, clarify and take back what they sent without an account, and the author
  never learns more about them than before.
- Deletion is one function per store, used by readers, the site Admin and the retention job
  alike (ADR 0108), and always leaves an audit trail without text.
