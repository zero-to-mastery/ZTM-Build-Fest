# ADR 0134: Answers are moderated in the one inbox, approved only under a shown parent and never by their own author

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#223](https://github.com/journey-to-code-org/open.blog/issues/223)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0103](0103-who-may-moderate-reader-participation.md),
  [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md),
  [ADR 0128](0128-only-the-bound-contributor-who-wrote-a-section-may-answer-as-its-author.md),
  [ADR 0129](0129-an-answer-is-the-authors-pending-words-named-as-the-section-is-and-follows-its-parent.md),
  [ADR 0132](0132-an-author-response-is-one-more-row-of-the-existing-feedback-table-stored-through-one-admin-route-behind-one-flag.md)

## Context

"Coordinator review" of an answer is RD12's moderation, not a second workflow. The one inbox must
list answers, show a moderator whose words they are and what they answer, and refuse the two
approvals that would contradict ADR 0128 and 0129: one by the account that wrote it, and one under
a reflection that is not shown.

## Decision

- **The inbox lists answers beside every other kind**, read back strictly (`HostedAuthorResponse`):
  an unknown field, a missing parent or binding, an unknown standing, an account that is not an Admin
  account name, a clarification or consent a reader would have (an answer has none), a second
  revision, a body that is not plain text, or a target that is not an attributed section of its own
  responder refuses that one item and counts it as invalid, naming no value. `Protocol::Protected`
  only: the inbox's schema alone does not offer answers.
- **Who decides is RD12's table, unchanged.** The site Admin and the work's coordinators approve,
  reject, remove and (the Admin) reopen; a contributing author moderates nothing. A request for
  clarification is never offered (the kind has none). Beyond the table, the inbox refuses
  `approve` by the account that wrote the answer (`may_decide_response`, the same rule in the hosted
  function): a coordinator who is also the section's contributor may write an answer but not
  approve it. Rejecting or removing one's own words is allowed.
- **An approval is checked against its parent as the store holds it now.** Admin reads the parent
  again and `Inbox::check_answer_approval` refuses unless it is the answer's own parent, a Third
  Perspective of the same work, shown to readers now (approved at its current text, not under a
  request to clarify, kept, both the approving and the current consent agreeing to publish, its kind
  shown on the post) and about an attributed section of the very contributor who answered (`409
  parentUnavailable` when not shown, `422 responderMismatch` or `notAttributed` otherwise). The
  hosted function checks the same again from its own rows before the database applies the change.
  Where the function does not record answers (no flag), approval is refused; every other decision is
  not.
- **The moderator sees the answer as the author's words**, headed "The author's answer", with the
  section's author as published, the standing it was written under ("the section has changed or
  been removed since the reader read it" when it is stale, never claiming which), a plain note that
  it is never approved by the account that wrote it and is hidden whenever the reflection is, the
  parent's id and section, and, to the site Admin only, the account that wrote it. The participant
  binding is never sent. Text stays text.
- **An answer is published nowhere by this change.** Approving one writes no file (`reader-feedback.json`
  and `third-perspectives.json` are untouched), so there is nothing to take it off; showing it under
  its reflection is #224's, from `response_shown`, which already requires the stored responder to be
  the section's own contributor (ADR 0129).

## Consequences

Coordinators moderate answers where they moderate everything else, with the same reasons, versions
and audit trail. The only new refusals are the two above.
