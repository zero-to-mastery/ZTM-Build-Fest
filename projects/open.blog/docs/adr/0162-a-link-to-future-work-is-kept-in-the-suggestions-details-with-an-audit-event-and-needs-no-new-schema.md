# ADR 0162: A link to future work is kept in the suggestion's details with an audit event, and needs no new schema

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#228](https://github.com/journey-to-code-org/open.blog/issues/228)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0154](0154-a-suggestion-is-one-feedback-row-with-no-passage-target-and-one-loosened-check.md), [ADR 0157](0157-converting-a-suggestion-is-an-explicit-author-action-that-records-an-id-and-never-enters-the-source-library.md), [ADR 0108](0108-retention-runs-from-a-dry-run-and-quotas-keep-only-hourly-digests.md)

## Context

[ADR 0157](0157-converting-a-suggestion-is-an-explicit-author-action-that-records-an-id-and-never-enters-the-source-library.md)
decided what a link is and who may record one, and left where it is kept and how an editor records it to
this task. A link holds only a kind, the id of what the author made, a time and the Admin account that
recorded it. A hosted change that adds a table or column would be a one-way door for every site.

## Decision

- **A link is kept in the row's own `details`**, as `conversions`: one to eight `{kind, id, at, by}`
  objects, newest last, none repeated. A suggestion with no link has no such field, so a row stored
  before this change reads, writes and serialises exactly as it did, and a site that never links one
  stores nothing new. `Suggestion::conversions`, `stored_details` and `from_stored` (Rust) and
  `readConversions` and `planConversion` (browser and function) are the only readers and writers, held
  to each other by `tests/fixtures/future-suggestion-outcomes.json`, which the Rust side generates.
- **No schema change.** The column is the existing `details jsonb`; the audit table's `action` is a
  shape (`^[a-z][a-z-]{0,31}$`), so `convert` needs no migration. Nothing to roll back: removing the
  feature leaves a field a reader of `details` ignores and the one function that wrote it no longer
  writes.
- **The link is recorded by one explicit author action.** Admin's `POST engagement/suggestions/link`
  names the item, the version seen and the target; the one grant rule (`convert`) decides it for the
  signed-in account, and the hosted function decides again from the stored row (`PATCH admin/moderation`
  with action `convert`). The row is changed only while it still has the version, the approval of its
  current text and its state Admin saw; the change raises the version, so a view from before can no
  longer act, and one audit event `convert` is written with the account and role. The event holds
  neither the target nor anything the reader wrote. It is not a moderation transition: the state does
  not change.
- **Nothing is created, fetched, published or sent.** The draft, series or source must already be
  the author's own; none is read, opened or checked, and a renamed or removed target leaves the
  record as the author made it (they record a new link). A link about a renamed page keeps the page
  the suggestion was sent from. Withdrawal and retention purge the row's `details`, links included,
  with its text.
- **The stored details have room for them.** A submission's `details` are held to 11 KiB, measured as
  Postgres measures them ([ADR 0165](0165-a-suggestions-stored-details-are-held-to-a-bound-below-the-columns-check-measured-as-postgres-measures-them.md)),
  so eight links at their widest (non-ASCII slugs, the longest account name) always fit the column's
  16 KiB. A test measures the sum.
- **The generic feedback route never decides a suggestion**: `PATCH admin/feedback` refuses it with
  `useModerationInbox`, because a decision or a link carries an audit event the inbox writes.
- **The audit event is written after the link, best-effort.** The link is a `PATCH` guarded on the
  version, and the `convert` event is a second request after it succeeds; it is not in one
  transaction with it (the moderation RPCs are, but they move a state, and adding one RPC for this
  would be new SQL for a record that changes no state). If the event fails it is logged and the link
  stands, because the link is the author's own record and the version raise has already stopped any
  stale view acting. The cost is that a failed event leaves a link with no event, which the dry-run
  never reads; it never leaves an event without a link. A test holds the link standing when the
  event cannot be written. Linking also needs suggestions and engagement protection both switched
  on, and says so when they are not (a clear 422, not a store error).
