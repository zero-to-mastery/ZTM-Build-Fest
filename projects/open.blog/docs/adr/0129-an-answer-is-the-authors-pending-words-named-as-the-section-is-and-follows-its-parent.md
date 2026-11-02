# ADR 0129: An answer is the author's own pending words, named as the section is, and follows its parent

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#212](https://github.com/journey-to-code-org/open.blog/issues/212)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0104](0104-retention-audit-events-and-abuse-reports-fail-closed.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0128](0128-only-the-bound-contributor-who-wrote-a-section-may-answer-as-its-author.md)

## Context

An answer is public prose by a named person, attached to a reader's words. It must be honest about
who wrote it and about what it answers, and it must not outlive or contradict moderation of the
reader's note.

## Decision

- **Public attribution** is the name the section is published under, with the public contributor
  handle and the section's standing; never an account or a participant id. The participant binding
  stays private, in the audit event (`actorId` is the Admin account, as for every Admin action) and
  in `Responder::participant`. The answer is the author's own words and creates no work credit and
  no reader attribution.
- **Pending by default and moderated like everything else.** It starts pending; approval and
  removal are RD12's, by a coordinator or the site Admin; clarification never applies (authors are
  not asked); retention and audit follow ADR 0104 unchanged. Replying sends nothing to the reader.
- **It follows its parent, and its stored responder must match.** `response_shown` is true only
  while the answer is public itself, the Third Perspective it answers is public now under its own
  mode, and, when that perspective is about an attributed section, the answer's stored responder
  contributor equals the section's contributor. An answer stored without a responder, or with
  another's, is never shown under an attributed parent. Removing, withdrawing, purging or hiding
  the reader's note hides the answer without deleting it, so a reader's words are never displayed
  as if answered after they are taken down, and an answer is never orphaned on a page.
- **Honest context for changes.** An answer written about a section that has since changed carries
  the section's standing (ADR 0127), so the page can say the section changed after the reader read
  it. Removing an author from the publication does not delete what they already published; a
  coordinator removes an answer when it should go.
- **No nesting.** An answer cannot be answered (RD12 refuses an author response to an author
  response), and a reader replying to an answer is out of scope: this is not a discussion tree.

## Consequences

#223 stores the answer and its responder through the existing hosted participation seam (ADR
0130) and #224 renders it from `response_shown` and the stored responder's published name, without
new vocabulary.
