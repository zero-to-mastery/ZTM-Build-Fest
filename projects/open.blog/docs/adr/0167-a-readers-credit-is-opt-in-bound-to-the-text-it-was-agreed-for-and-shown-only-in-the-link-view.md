# ADR 0167: A reader's credit is opt-in, bound to the text it was agreed for, and shown only in the link view

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#228](https://github.com/journey-to-code-org/open.blog/issues/228)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md), [ADR 0162](0162-a-link-to-future-work-is-kept-in-the-suggestions-details-with-an-audit-event-and-needs-no-new-schema.md)

## Context

The story says public credit is opt-in and revision-bound. [ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md)
made credit opt-in (`publishName`) but a clarification replaces the text and raises the revision,
and the old `publishName` stayed in force for words the reader had not agreed to be credited for.

## Decision

- **Consent is recorded for a revision.** A suggestion keeps `creditRevision`, the text revision the
  reader agreed to be credited by name for, in the row's `details` (no schema change; `details` is
  already read strictly and now also allows `creditRevision`). It is set to 1 when they send the
  suggestion with `publishName` and a name.
- **A clarification that changes the text needs fresh consent.** It raises the revision and leaves
  `creditRevision` behind, so the old agreement no longer matches. It never carries consent with
  it: the reader agrees again by their receipt, for the text as it now stands.
- **A changed consent is the reader's own act, by their receipt.** The new `credit` action sets or
  clears `publish_name` and `creditRevision` together, guarded by the row's version. Agreeing binds
  it to the current revision and needs a name; withdrawing clears both. An agreement with no binding
  offers nothing.
- **A credit is exposed only when it matches.** `Suggestion::credit` (and the hosted
  `suggestionCredit`) returns the name only when `publishName` is set and `creditRevision` equals the
  current `item_revision`. A coordinator or contributing author sees a name only under the same rule.
- **It is shown in one place.** The Admin's link view says "The reader agreed to be credited as X
  for this text. Nothing credits them unless you do." beside the link form, and nowhere else: not in
  the receipt shown to others, a library candidate, a research-note export, the audit event, a feed
  or any public page. Nothing publishes it automatically, and nothing in the system acts on it.
- **Withdrawal and retention remove it.** A withdrawal or a retention purge deletes the text,
  `details` and name (`publish_name` is reset), so there is nothing to credit and no view to show
  it in. The clearing of private identity after a link (ADR 0163) is unchanged: it keeps the name a
  reader agreed to show and clears the rest, but the agreement still has to match the text to be
  offered.
- **The stored record's size is unaffected in practice.** `creditRevision` adds under 30 bytes to
  `details`, which the room kept for links (ADR 0165) covers, and a test includes it.
