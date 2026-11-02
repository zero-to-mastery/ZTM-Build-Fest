# ADR 0152: A future suggestion is one more participation kind whose approval admits it to the editors' queue and publishes nothing

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md), [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md), [ADR 0103](0103-who-may-moderate-reader-participation.md), [ADR 0104](0104-retention-audit-events-and-abuse-reports-fail-closed.md), [ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md)

## Context

RD13 lets a reader send the editors a question, text, video or other source for possible future
work. RD12 made one registry of participation kinds and one moderation state machine, and every
kind in it is either published after approval (comments, reflections, answers) or never public
(abuse reports, whose approval means "upheld"). A suggestion is neither: it is meant for the
editors, so approval cannot mean "show it", and it is useful for far longer than a rejected item
is kept.

## Decision

- **One new kind, `future-suggestion`, in the existing registry**, not a parallel system. It is
  created by any reader without an account, targets the page it was sent from, may be asked to
  clarify (with the reader's consent) and gets a private receipt, so every mode, quota, state,
  role grant, reason, audit event and deletion rule of the one policy applies unchanged. It
  starts `off` for every site and a post cannot turn it on.
- **It is not publishable.** `is_public` is false for it in every state and mode, so no feed,
  page, export or count can show one, whatever a later projection forgets to check.
- **A new fixed rule, `editorial`, says what approval means for such a kind.** Approving admits the
  suggestion to the editors' private queue; it stays kept while approved (retention does not purge
  it on the closed-item clock the way an upheld abuse report is purged), and an editor closes it
  with the same `remove` an approved public item has, with a decline reason, after which the
  ordinary closed-item retention applies. The reader may still withdraw it or ask for deletion.
  What is kept is the idea, not the person: once `closedDays` have passed since approval, or when an
  author links it to future work, retention clears the reader's contact and unpublished name and
  nothing else ([ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md)),
  as a fourth retention step beside expiry and the two purges.
- **Approval is the site Admin's or a coordinator's**, as everywhere (the one grant list). A
  contributing author, the public and the retention job never decide.
- **The setting was inert until the submission route existed**, so naming `future-suggestion` in
  `participation.kinds` changed nothing while RD13.1 shipped alone. RD13.2
  ([#227](https://github.com/journey-to-code-org/open.blog/issues/227)) adds the form, the hosted
  route and the inbox listing together
  ([ADR 0158](0158-suggestions-are-sent-through-the-one-feedback-route-behind-their-own-opt-in-with-the-page-as-work.md)),
  and the setting is live from then on.

## Consequences

- The transition, protection and matrix fixtures gain rows for the kind; the hosted function's
  mirror (`netlify/lib/participation-moderation.mjs`) is checked against them case by case.
- A kind that is neither public nor an abuse report is now possible, so code must ask the rules
  (`publishable`, `editorial`), never compare kinds, which the policy already did for abuse
  reports only. The hosted function asks `isPublishable(kind)` before any receipt says an item is
  "published" or a report treats it as shown
  ([ADR 0161](0161-a-kind-that-is-never-public-is-never-called-published-shown-or-reportable.md)).
- Retention gains a step, `scrub-identity`, for an approved editorial item; the retention fixture
  gains that value for this kind and no other row changes.
