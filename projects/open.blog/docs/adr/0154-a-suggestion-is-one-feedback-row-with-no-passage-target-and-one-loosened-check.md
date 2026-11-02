# ADR 0154: A suggestion is one feedback row with no passage target and one loosened check

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md), [ADR 0113](0113-third-perspectives-are-one-feedback-row-submitted-through-the-one-route-with-a-receipt.md), [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md)

## Context

The hosted feedback table already stores one row per participation item, with the text in `body`,
the reader's name in two columns, the page in `work`, the receiver's time and a `details` object.
Its `kind` check is a shape (`^[a-z][a-z0-9-]{0,39}$`). Its passage columns were checked as "all
three, or none for a future kind that is about the whole work": `work`, `revision` and `target`
together or all null. That was read as allowing a suggestion, which has a page and no passage; it
does not. A row with `work` set and no revision or target failed `openblog_feedback_passage_complete`,
so the first suggestion would have been refused by the database. Release v0.38.1 also learned that the
inbox must not attach one kind's fields to other kinds, because the Rust readers refuse unknown
fields.

## Decision

_Amended by [ADR 0165](0165-a-suggestions-stored-details-are-held-to-a-bound-below-the-columns-check-measured-as-postgres-measures-them.md)
(the size `details` may reach), [ADR 0166](0166-only-a-suggestion-may-have-a-page-without-a-passage-and-the-rollback-names-the-audit-guard.md)
(the loosened check names the kind) and [ADR 0162](0162-a-link-to-future-work-is-kept-in-the-suggestions-details-with-an-audit-event-and-needs-no-new-schema.md)
(`details` may also hold `conversions`)._

- **A suggestion is one row of that table** with kind `future-suggestion`: the page it was sent from
  in `work`, no passage `revision` and no `target` (it is not about a passage), `body` the reader's
  words, `item_revision` the text revision, and `details` exactly `{type, url?, hints?, about?,
  contact?}`. The reader's name stays in its two columns, never in `details`.
- **One hosted schema change, additive and opt-in.** The check becomes
  `(revision is null and target is null) or (work is not null and revision is not null and target is
  not null)`. It loosens and nothing else: every row the old check allowed satisfies the new one, no
  stored row changes or is rewritten, and a half-set passage is still refused. `supabase/feedback.sql`
  creates a fresh table with it, and for an existing table drops the constraint if it exists and adds
  the new one, so running the file again is safe. A site opts in by running it again, as for every
  hosted addition, and by `OPENBLOG_SUGGESTIONS_ENABLED`
  ([ADR 0158](0158-suggestions-are-sent-through-the-one-feedback-route-behind-their-own-opt-in-with-the-page-as-work.md)).
- **The rollback refuses before it harms.** `supabase/future-suggestions-rollback.sql` restores the old
  check, but only while no row has a page and no passage, which is what every suggestion is. It
  raises an error naming what to do (export the rows, delete them and the audit events that refer to
  them) and changes nothing; it never deletes a reader's row itself.
- **`Suggestion::stored_details` and `Suggestion::from_stored` are the only readers and writers of
  that shape**, as strict as a submission. `details` is read as a typed record that refuses any other
  field (`deny_unknown_fields`), so a row cannot smuggle the reader's text or name in a second copy,
  and a row that does not read back is refused whole.
- **There is no passage target in version 1.** `about` (a series or an article, by the site's own
  slug or path) is the target a suggestion has. A passage target would be a field a version 1 reader
  refuses, so adding one later is version 2; the loosened check already lets a row carry all three
  columns, so it needs no schema change then.
- **The inbox holds the kind.** `Source::holds` accepts `future-suggestion` for the feedback store,
  and the listing reads a suggestion row into `Content::Suggestion` through `from_stored`; no
  suggestion field is attached to any other kind's projection.
- **The receiver stamps the receipt**: the page (`work`, a published page path the site's own
  manifest says is open for the kind), the time and the channel; the reader's clock is not used.

## Consequences

A site that never sets `OPENBLOG_SUGGESTIONS_ENABLED` never needs the changed check. A site that
runs the file again and later turns suggestions off keeps a schema that works for every other kind.
If a later task needs a column (for example to index duplicates), that is an additive migration to
decide then, not a reason to store the record elsewhere.
