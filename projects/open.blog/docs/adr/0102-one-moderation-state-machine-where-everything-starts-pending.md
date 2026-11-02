# ADR 0102: One moderation state machine, where every submission starts pending and only an approved revision is public

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#211](https://github.com/journey-to-code-org/open.blog/issues/211)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md)
- Coordinates with: [#225](https://github.com/journey-to-code-org/open.blog/issues/225) (inbox),
  [#226](https://github.com/journey-to-code-org/open.blog/issues/226) (abuse, retention),
  [#214](https://github.com/journey-to-code-org/open.blog/issues/214) (RD14 consent and withdrawal),
  [#199](https://github.com/journey-to-code-org/open.blog/issues/199) (RD6 correction decisions)

## Context

Hosted comments have three statuses, `pending`, `approved` and `rejected`, and the function lets
the moderation token set either of the last two from any status. RD12 needs clarification,
removal and abuse handling as explicit states (#203), the inbox needs conflict-aware actions on
the current revision (#225), RD14 needs withdrawal, and every kind must share one machine rather
than grow its own. The issue's acceptance criteria are that all public submissions default to
pending, that clarification never publishes the original, and that removal fails closed.

## Decision

- **States** (`openblog_core::moderation::ModerationState`, stored ids in brackets):
  pending (`pending`), clarification requested (`clarification`), approved (`approved`),
  rejected (`rejected`), removed (`removed`) and withdrawn (`withdrawn`). Only approved can be
  public. Rejected, removed and withdrawn are closed.
- **Creating an item** (`ModerationPolicy::admit`) always yields pending at version 1 and revision
  1, for every kind and every actor, including an author's response and an author's manual entry
  of copied feedback. The kind's effective mode must be `open`: `hidden` answers `unavailable`,
  `locked` answers `closed`. A response or report needs a parent that is public now, on the same
  work; anything else answers `unavailable`, the same as a parent that does not exist. Nothing is
  ever created public.
- **Transitions** (`ModerationAction`), the complete list; every other pair is refused:

  | Action | From | To | Reason |
  | --- | --- | --- | --- |
  | `approve` | pending (not a revision a clarification asked about) | approved | none |
  | `reject` | pending, clarification | rejected | required |
  | `request-clarification` | pending | clarification | required |
  | `clarify` (the submitter's answer) | clarification | pending, as a new revision | none |
  | `remove` | approved | removed | required |
  | `reopen` | rejected, removed (text still kept) | pending, or clarification when its current revision was asked about | none |
  | `withdraw` | pending, clarification, approved | withdrawn | none |
  | `expire` (retention, ADR 0104) | pending, clarification | rejected (`expired`) | set by policy |
  | `uphold-report` (ADR 0104) | pending (abuse report) | approved (never public) | required |

  Approving an abuse report directly, removing one, and asking an author or a reporter to clarify
  do not apply to those kinds. A rejected, removed or withdrawn item never goes straight back to
  approved: reopening returns it to pending for a fresh decision, and a withdrawn item is never
  reopened, because its submitter took it back.
- **Clarification never publishes the original.** Asking needs the submitter's clarification
  consent, recorded at submission, and a reason (`unclear`, `needs-source`, `personal-data`,
  `other`). Nothing can approve an item in clarification. The submitter's answer replaces the text
  as revision n + 1 and returns it to pending; the transition names the superseded revision, whose
  text the caller must not keep as a publishable revision. An approval binds to the revision it
  approved (`approved_revision`), and an item is public only while that equals its current
  revision. Delivering the request to the reader is not an e-mail: no part of this policy sends
  anything to a reader, and a transport may only show the request through a channel the reader
  holds (such as a private receipt link).
- **The question outlives rejection and expiry.** A clarification request records the revision it
  asked about on the item (`clarification_asked`), and nothing but the submitter's answer, a later
  revision, moves past it. While the current revision is the one asked about, `approve` is refused
  and `is_public` is false whatever the stored state says, and `reopen` of an item that was
  rejected or expired before the submitter answered returns it to clarification, not pending. The
  reader can still answer, and the original text never becomes approvable by a detour through
  rejection or expiry.
- **Conflict-aware and replay-safe.** Every item has a version that every transition raises by
  one; every request names the version it saw, and anything else is `stale`. Replaying a request,
  or acting on a view of the item from before someone else's decision or a clarification, changes
  nothing.
- **One public test.** `moderation::is_public(item, mode)` is true only for a publishable kind,
  approved at its current revision, with its text still kept, while its kind's mode on the post is
  `locked` or `open`. Pages, counts, previews, feeds and the public read path use it; pending,
  clarification, rejected, removed, withdrawn and any state id this version does not recognise
  are private, and no public count includes them.
- **Reasons are grounds, not verdicts.** `ReasonCode` is `spam`, `abusive`, `personal-data`,
  `off-topic`, `duplicate`, `rights`, `unclear`, `needs-source`, `no-action` (dismissing a
  report) and `other`, plus `upheld-report` and `expired`, which only the policy sets. There is no
  "incorrect" or "misinformation" code: rejecting a suggested correction is a moderation decision,
  not a finding that the reader was wrong (RD6 owns correction decisions).
- **Existing comments.** The `openblog_comments.status` column holds `pending`, `approved` and
  `rejected` today. `legacy_comment_status` maps every state onto those without ever making a
  private state public (removed and withdrawn store as `rejected`); comments carry no
  clarification consent and no submitter receipt, so they never reach clarification or
  withdrawal. Widening the column, if wanted, is an additive migration for #226. The hosted
  function adopts these rules (no straight rejected-to-approved change, versions, reasons) with
  the inbox (#225); until then its existing behaviour is unchanged. (Amended by
  [ADR 0106](0106-the-inbox-adds-columns-an-audit-table-and-conditional-functions-opt-in.md):
  the column is not widened; comments gain the full state in a new `moderation_state` column
  beside it, with a version and an audit table, opt in, and the inbox adopts the rules.)
- **Errors change nothing and say nothing.** `PolicyError` codes (`denied`, `unavailable`,
  `closed`, `stale`, `notAllowed`, `reasonRequired`, `reasonNotAllowed`, `consentRequired`,
  `contentPurged`, `notDue`, `reportMismatch`, `invalidTarget`) carry fixed messages that name no
  item text, identity or stored value. Checks run in a fixed order, grant first (ADR 0103), so an
  actor without a grant learns nothing about an item's state.

## Considered options

- **Keep the three comment statuses and encode the rest in flags.** Rejected: removal, withdrawal
  and clarification would be indistinguishable from rejection in the inbox and in retention.
- **Approve the clarified text in place.** Rejected: a moderator could approve what they saw
  before the answer, publishing the original the reader was asked to change.
- **Let reports hide their target automatically.** Rejected: anyone could take approved content
  down by reporting it. An upheld report removes its target (ADR 0104); a report alone changes
  nothing public.

## Consequences

- One machine serves comments, passage feedback, Third Perspectives, author responses and abuse
  reports; the inbox (#225) filters by kind and state and shows each action with its reason list.
- Every decision is a pure function of stored facts, so the hosted function, Admin and tests can
  share it; a reviewed matrix of every kind, state, action and role is checked in
  (`crates/openblog-core/tests/fixtures/participation-moderation-matrix.txt`).
