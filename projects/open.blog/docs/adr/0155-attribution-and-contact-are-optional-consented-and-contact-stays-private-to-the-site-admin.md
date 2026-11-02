# ADR 0155: Attribution and contact are optional and consented, and contact is private to the site Admin and the submitter

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md), [ADR 0103](0103-who-may-moderate-reader-participation.md), [ADR 0104](0104-retention-audit-events-and-abuse-reports-fail-closed.md)

## Context

An editor may want to credit an idea or ask about it, but a reader who sends a link has not agreed
to be emailed, listed or thanked in public.

## Decision

- **Display is anonymous by default.** A suggestion keeps the reader's name only if they gave one,
  and shows it publicly only if they also set `publishName`. A name needs no publication consent
  to be kept privately; `publishName` without a name is refused. `Suggestion::credit` returns only
  a consented name (for the current text, ADR 0167), and nothing in the system uses it: crediting
  a reader is the author's own later action.
- **Contact is optional and consented.** `contact` is `{address, followUp}`: one plain ASCII
  e-mail address (no display name, comment, quoting, list or whitespace, at most 254 bytes) and
  `followUp: true`, the reader's agreement to be contacted about this suggestion. An address
  without that agreement is refused, not dropped silently. Nothing but the reader's own word
  collects it; it is never required.
- **Contact is private.** It is shown only to those who may see a reader's private identity (the
  one `View::PrivateIdentity` rule: the site Admin and the submitter), never to a coordinator,
  contributing author or the public, and the same holds for an unpublished name. It is excluded
  from audit events, conversions, library candidates and `Debug` output (which prints
  `Contact(<private>)`, and prints a name the reader did not agree to show as `<private>`, in
  `Submission`, `Suggestion` and the editor's view alike), and is purged with the text on
  withdrawal, deletion and retention.
- **They are not kept as long as the idea.** (Amended by [ADR 0163](0163-editorial-outcomes-are-derived-the-receipt-says-the-honest-standing-and-a-link-clears-private-identity-in-the-next-retention-run.md): the identity is cleared at the next confirmed retention run after a link, not the moment of the link. Amended by [ADR 0167](0167-a-readers-credit-is-opt-in-bound-to-the-text-it-was-agreed-for-and-shown-only-in-the-link-view.md): the agreement to show a name stands only for the text it was given for.) An accepted suggestion is kept, but its contact and
  unpublished name are cleared (and nothing else) once `closedDays` have passed since it was
  approved, or the moment an author links it to future work
  (`RetentionStep::ScrubIdentity`, `identity_scrub_due`). A name the reader agreed to show stays. The
  hosted retention run does it as its own step, `scrub-identity`, listed in the dry run only for an
  approved suggestion that still holds some (so a run's batch never fills with ones already cleared),
  applied only while the row is still the approved one the dry run listed, with a version raise and an
  audit event that holds nothing of the reader. Where links are persisted is
  [#228](https://github.com/journey-to-code-org/open.blog/issues/228)'s: until then the hosted run
  clears on the period alone, and the conversion rule is the pure function #228 will call.
- **Showing a suggestion is gated where it is built.** `Suggestion::editor_view` returns `None`
  unless `may_view(actor, item, mode, View::Content)` allows it (an actor with no role on the work, or
  text already purged, gets nothing), and the contact and unpublished name only where
  `View::PrivateIdentity` does.
- **Nothing here sends a message.** open.blog never emails a suggester. If an editor decides to
  write to someone, that is outside the system, and it is the editor's to do with the address
  they are allowed to see.
