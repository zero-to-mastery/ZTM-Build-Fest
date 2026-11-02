# ADR 0105: One moderation inbox, where every item is shown and decided by the one policy for the viewer's role on its work

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#225](https://github.com/journey-to-code-org/open.blog/issues/225)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0103](0103-who-may-moderate-reader-participation.md),
  [ADR 0104](0104-retention-audit-events-and-abuse-reports-fail-closed.md)
- Amends: ADR 0083 (Admin's Reader feedback view and its `engagement/feedback` moderation routes
  are absorbed here)
- Coordinates with: [#226](https://github.com/journey-to-code-org/open.blog/issues/226)
  (retention, abuse reports, reader receipts)

## Context

Admin moderated hosted comments in a section of Analytics (three statuses, approve or reject from
any of them, no version) and passage feedback in B5's Reader feedback view (approve, reject and
remove, version-checked). ADRs 0102 to 0104 define one state machine, one role model and one
retention policy for every participation kind; #225 asks for one accessible inbox driven by them,
with server authorization and the current revision on every action, nothing pending leaking
through counts or previews, and clarification and removal distinct from approval and rejection.

## Decision

- **One inbox.** Admin's **Moderation inbox** (`#/moderation/{state}?kind=`) replaces both views;
  B5's `#/feedback` address opens it. Its Admin routes are `GET engagement/moderation?state=&kind=&after=`
  and `PATCH engagement/moderation`; the old `engagement/comments` and `GET`/`PATCH
  engagement/feedback` routes are gone. B5's publishing routes (`engagement/feedback/publish`,
  `unpublish`, `published`, `response`, `revision-note`) stay, and the inbox page keeps B5's
  "Published on your posts" section for responses and revision notes.
- **One list, filtered by state and kind.** The six states of ADR 0102 are the inbox's tabs,
  pending first; a kind filter narrows it to one participation kind. Comments and passage feedback
  are merged oldest first. Every kind that later gains a store joins the same list.
- **Paged by a keyset cursor.** The hosted function returns at most 50 items after an opaque
  cursor (the row's time to the microsecond, in UTC, and its id), merging each store's next rows
  in that order, so items are never skipped or repeated across pages however many arrive. Admin
  shows "Show more" and moves focus to the first new item. An account bound in a shared
  publication, which may not see every item, is given further hosted pages (at most 20 per
  request) until it has a page of items it may see or the list ends, and reaching that bound
  with nothing it may see ends its list, so an empty page or a "Show more" never betrays items
  hidden from it, and it is not told how many items failed validation.
- **Read again, strictly.** `openblog_core::moderation_inbox::InboxItem` reads each hosted item:
  a comment (UUID id, a state comments can be in, version, post path, plain name of at most 80
  characters, text of at most 4,000) or a passage feedback record (B5's `HostedFeedback`, now with
  the item's revision, approved revision, clarification revision and the reader's consent to be
  asked). A bad item is counted and never shown half-checked; one never hides the rest. An item
  stored before the inbox reads as revision 1, nobody asked, no consent; one approved then reads as
  approved at its only revision.
- **Each item has its own actor.** For every item, `Inbox::actor` resolves the signed-in account
  with `SharedWorks::actor` on that item's work (ADR 0103): the site Admin, a coordinator, a
  contributing author, or nobody. Nothing about who is acting comes from the request. An item the
  account may not see (no moderation role on the work, a binding that grants nothing, a path no
  loaded post has for a bound co-writer, an abuse report for a contributing author) is left out of
  the page entirely, and nothing counts it: the status line says only how many items are shown, so
  no count or preview reveals a pending item.
- **The policy decides what is offered.** The inbox's actions are approve, ask to clarify, reject,
  remove and reopen. An item is offered exactly those `ModerationPolicy::decide` accepts now for
  that actor (with a reason the action takes), intersected with what the hosted schema can store
  (ADR 0106): so a coordinator never sees reopen, a contributing author sees no decision, the text
  a clarification asked about is never offered for approval and reopens to clarification, asking
  to clarify needs the reader's consent, and removal is offered only for approved items. Each
  action lists its reasons (ADR 0102; there is no "incorrect") and a line of guidance: what it
  does and, for a decision that closes the item, how long its text is kept (ADR 0104).
- **A private name stays with the site Admin.** A comment's name is always shown with it. A
  feedback reader's name is shown when they agreed to publish it; otherwise only to the site
  Admin, and a coordinator or contributing author reads "The reader gave a name that only the site
  Admin can see."
- **Every decision is decided three times and written once.** `PATCH engagement/moderation` takes
  the item's source, id, state and version as loaded, the action, a reason and, to approve passage
  feedback whose passage is not current, the passage check the moderator confirmed (ADR 0083). Admin
  reads the item again, resolves the actor, decides with the policy (a refusal answers `403
  denied`, a stale view `409 conflict` with the item as it is now, anything else `422` with the
  policy's code), confirms the passage, and sends the hosted function the decision with the actor's
  account and role. The function decides again from the stored row with the same rules
  (`netlify/lib/participation-moderation.mjs`) and writes the change and its audit event in one
  conditional statement (ADR 0106). An approved or removed feedback item then updates
  `reader-feedback.json` as ADR 0083 says.
- **One shared fixture.** `tests/fixtures/participation-transitions.json` holds every inbox
  decision for every moderator role, for comments, a passage kind, author responses and abuse
  reports, in every state with each kind of starting facts, plus the refusals a request can earn on
  its own. The Rust policy generates it (a test fails if it drifts) and the hosted function's
  rules must agree with every case. B5's `planModeration` is now that machine cut to its three
  actions.
- **Accessible by construction.** Every control is a native, labelled control; each decision's
  guidance is its accessible description; a reason is chosen before a destructive decision, with
  focus moved to it when missing; outcomes and failures are announced in live regions and focus
  moves to the status line; the passage confirmation takes focus when it is missing; state tabs
  wrap and every control fits a 320px viewport; nothing is built from markup, so hostile text stays
  text. Nothing is e-mailed to anyone.

## Considered options

- **Keep two views over one policy.** Rejected: two lists to watch, and two places for the role
  and privacy rules to drift.
- **Compute the offered actions in the browser.** Rejected: the browser cannot know the actor's
  role on a work or a reader's private name without being sent what it should not see.
- **Page by offset.** Rejected: items arriving or being decided between pages would shift the
  offset and skip or repeat items.
- **Report how many items a viewer cannot see.** Rejected: a count of hidden pending items is
  exactly the leak the issue forbids.

## Consequences

- Comments gain removal and reopening as states of their own, versions and an audit trail once the
  hosted schema allows (ADR 0106); until then the inbox offers what the older schema can store.
- Third Perspectives, author responses and abuse reports join the list as their stores arrive;
  upholding a report is decided by the same policy once reports are stored (#226). Abuse reports
  joined with their item's snapshot, and the site Admin's deletion request is an inbox action on
  closed items ([ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md)).
- Reader receipts (#226) are what lets a reader answer a clarification or withdraw; the inbox
  already shows those states and never offers the reader's own actions to a moderator.
