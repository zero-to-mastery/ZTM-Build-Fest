# ADR 0133: Admin decides who may answer against the private record, and sends the function only a checked request

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#223](https://github.com/journey-to-code-org/open.blog/issues/223)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0007](0007-private-shared-publication-records.md),
  [ADR 0103](0103-who-may-moderate-reader-participation.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md),
  [ADR 0128](0128-only-the-bound-contributor-who-wrote-a-section-may-answer-as-its-author.md),
  [ADR 0132](0132-an-author-response-is-one-more-row-of-the-existing-feedback-table-stored-through-one-admin-route-behind-one-flag.md)

## Context

Whether someone is the author of a section depends on the private record (who is bound to which
participant and with which roles). That check belongs where the record is, on Admin's own host,
behind the existing session and CSRF seams, and it must give a non-author no information.

## Decision

- **`POST /admin/api/engagement/author-response`** takes `{parent, parentVersion, body}` and nothing
  about who is answering, as whom or about which section. Admin reads the parent from the hosted
  inbox, then calls `admit_response` (ADR 0128) with the signed-in account, the shared publication
  record whose post is that work, the post's committed body and its credits sidecar read from the
  content folder as committed, and the parent's stored target. Every refusal before the author is
  confirmed is the same `403 denied` for another contributor, a coordinator, the publication's
  owner, a reader, an account bound to nothing, a binding since removed or demoted, a participant
  since removed, an account since deactivated and a registry key since dropped; only after that
  does the parent's own state matter, so a non-author learns nothing about it.
- **After the author is confirmed**: `409 authorUnconfirmed` when no section by that
  contributor is published now (a changed section is fine and its standing is stored), `409
  parentUnavailable` when the parent is not shown to readers or its kind is hidden on the post
  (including a reader's consent that no longer agrees to publish), `422` for a parent about another
  section, `409 conflict` when the parent changed since the author loaded it, and `422 invalidBody`
  for text that is empty, over 4000 characters or contains control or text-direction characters
  (text is stored and shown as text, never as Markdown or HTML). The post's modes decide `403
  closed` (locked) and `404 unavailable` (hidden or off).
- **The request the function receives is built from what Admin decided**
  (`AuthorResponseRequest::new` over `Responder`, which came from `admit_response`), never from the
  browser's. It carries the participant binding and the Admin account privately and the contributor
  handle, the published name and the standing publicly (ADR 0132). What the function answers is
  passed on only as a short plain message and its code; an absent endpoint, credential or service,
  a refused token and a timeout are Admin's own plain failures, and nothing is claimed stored.
- **`PATCH /admin/api/engagement/author-response`** takes `{id, version}` and withdraws the answer
  only for the account that wrote it, only while it is still bound as a contributor to the stored
  participant (`Inbox::may_withdraw`), and only as RD12's withdrawal allows (pending or approved at
  the version loaded). A revoked member, another account and a coordinator get
  the same `404`, and the moderation token has no such route at all; a coordinator removes the answer
  instead.
- **The offer is the server's.** The inbox view of an approved, shown Third Perspective about an
  attributed section carries `answerAs` (the contributor, the published name and the standing) only
  for the signed-in contributor bound to that section, on a post where answers are open, and for
  nobody else; the card draws the form only then.
- **The moderator's check of a reflection about an author's section uses the author's published
  sections** (`AttributedSections`, from the post's body and credits), never B5's heading sections:
  `perspective.check` is `current` or `stale`, and `perspective.attributed` says the contributor, the
  author's published name and the standing.

## Consequences

The private record is read in one place, by Admin, for one question. The function and the browser
never see a participant id except the one Admin stores privately with the answer.
