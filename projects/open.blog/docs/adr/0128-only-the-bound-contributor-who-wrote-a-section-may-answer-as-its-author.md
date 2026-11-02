# ADR 0128: Only the bound contributor who wrote a section may answer as its author

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#212](https://github.com/journey-to-code-org/open.blog/issues/212)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0006](0006-collaborator-identity-binding.md),
  [ADR 0014](0014-record-level-authorization-and-publish-gate.md),
  [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md),
  [ADR 0103](0103-who-may-moderate-reader-participation.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md),
  [ADR 0127](0127-an-attributed-target-resolves-by-author-and-text-and-is-stale-rather-than-retargeted.md)

## Context

RD12's registry already says an author response is written by the site Admin, a coordinator or a
contributing author of the work. For a reader's note about one named author's section, "any author"
would let one co-author speak as another, and a contributor registry entry alone says who someone is
on the site, not that they wrote this section.

## Decision

- **One new action, `RespondAsAuthor`, in the existing collaboration authorization**, targeting a
  participant. Only the `contributor` role holds it, and only for the participant the requester's
  own binding names. The site owner, coordinator, editor and reader roles do not hold it, and a
  contributor registry key without a binding to that participant on this publication grants
  nothing: the account, the registry key and the participant must all still resolve (the existing
  check). Every refusal is the same `denied`, so nothing about another participant is learned.
- **Answering a Third Perspective about an attributed section requires all of**: the target is
  attributed (otherwise `not-attributed`, and RD12's generic author response applies unchanged,
  which is also what a whole-work or ordinary-heading perspective gets); the publication record is
  the one whose post is this work (checked against `SharedWorks`); the participant is found only by
  the binding whose public contributor id equals the target's, never by a name; the grant above on
  that participant; the actor is derived inside the function from the signed-in account (never
  supplied, so no pairing one account's grant with another's actor); the parent is a public Third
  Perspective of this very work; and the author still has a published section (below). The sections
  are built inside the function from the published body and credits, not taken from the caller.
  Then RD12's `ModerationPolicy::admit` applies as it does to every item: the answer is an
  `author-response`, always pending, under the kind's mode (hidden, locked and open behave as for
  every kind).
- **The policy itself refuses an impersonation.** `Submission` carries the parent's stored target,
  required for an answer to a Third Perspective, and an optional sealed `AuthorGrant` that only
  `admit_response` can issue. `ModerationPolicy::admit` refuses an `author-response` whose parent
  is about an attributed section (or a malformed reserved anchor) unless it carries the grant, so a
  coordinator, a site owner or the moderation token, all of whom RD12 otherwise lets write author
  responses, cannot post a plain one as the author. Leaving the target out is refused too.
- **The author must still have a section.** A changed section is fine and the page says it
  changed; if no section by that contributor is published now, the answer is `author-unconfirmed`.
  Ids are public registry keys read from committed content, so a person invited later under the
  same name or a participant id reused for someone else changes nothing: neither is consulted.
- **Coordinators and the site Admin moderate, never impersonate.** They approve, reject and remove
  the response by RD12's table unchanged, but a coordinator or site owner who is not that section's
  contributor cannot write as the author, and the moderation token never can. A coordinator who is
  also that section's contributor can write it through the contributor grant, but may not approve
  their own answer: `may_decide_response` refuses an approval by the account that wrote the
  response, the conservative choice, enforced where the response is stored because RD12's item
  facts do not carry the submitter. A contributing author never moderates at all.
- **Approval reads the responder against the record again.** Admin's approval of an answer runs
  `authorize_author` for the account and participant the row stores and requires the participant's
  binding to be that contributor and that account (`denied` otherwise, `403`), beside the parent
  check. A row written before a membership was revoked, and a row forged with the moderation token
  naming a responder it never had, are therefore never approved.
- **Withdrawing is the writing account's, and needs no membership.** RD12's `withdraw` as the
  submitter, for the account that wrote the answer: taking one's own words down is never the risk,
  so an author whose binding was removed or demoted after writing can still withdraw. A coordinator
  removes instead.

## Why a coordinator cannot answer as an author

Issue #223 says "the bound contributor or authorized coordinator responds as an author". This
decision reads that more narrowly, on purpose. A section is one person's words; an answer "as its
author" tells readers the author said it. A coordinator who is not that author would be putting
words in the author's mouth, under the author's name, which is the impersonation the story exists
to prevent, and a coordinator's real powers (approve, reject, remove, and clarifying with the
reader) already cover everything a coordinator needs in order to run the conversation. So the
coordinator's part is moderation, never speech as another, and a coordinator who is also the
section's contributor writes through the contributor grant and cannot approve their own answer. If
a site wants a coordinator to answer, they answer as themselves, as a reader's reflection would.

## Consequences

Group works need no special case: each section has exactly one author, and the grant is per
participant. A perspective on the whole work stays answerable by any in-scope author, as RD12 says.
