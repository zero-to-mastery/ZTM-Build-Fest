# ADR 0163: Editorial outcomes are derived, the receipt says the honest standing, and a link clears private identity in the next retention run

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#228](https://github.com/journey-to-code-org/open.blog/issues/228)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md), [ADR 0156](0156-acceptance-means-editorial-interest-only-and-nothing-ranks-or-counts-suggestions.md), [ADR 0162](0162-a-link-to-future-work-is-kept-in-the-suggestions-details-with-an-audit-event-and-needs-no-new-schema.md)

## Context

Editors need to see how each suggestion was dealt with (held, converted, declined or closed), and a
reader who kept their receipt should be told where it stands without being promised anything, ranked
or counted. A conversion also releases the reason the contact and unshown name were kept.

## Decision

- **Outcomes are derived, never stored.** `Outcome::of(state, conversions)` gives held (accepted,
  not linked), converted (linked, whether or not since closed), declined (rejected before it was
  accepted, or expired) and closed (accepted, then removed without ever being linked); undecided and
  withdrawn suggestions have none, because the machine removes only what was approved and a
  withdrawal is the reader's. Every change of state and every link is already in the private audit
  trail, so the outcome is recorded where decisions are. No outcome is a verdict on the idea.
- **The reader's receipt shows the honest standing**, derived by the function from the same two
  facts: `standing: {id, label, note, acceptance}`. The note is [`ACCEPTANCE_NOTICE`](0156-acceptance-means-editorial-interest-only-and-nothing-ranks-or-counts-suggestions.md)
  for interest, the same notice plus "an editor has recorded a link between it and work they are doing.
  That is a record, not a promise to publish" once linked, and for a decline "not taking an idea
  forward is about this site's plans; it is not a judgement of the idea or of you". Nothing ranks,
  counts or compares, nothing says it was checked, endorsed or will be published, and nothing names
  what it was linked to: the receipt's `details` carry no `conversions`. A receipt for a purged
  suggestion has no standing, because what was linked is gone with it. A service that does not send
  a standing reads as it did.
- **A link releases the private identity at the next retention run, not before.** The retention
  run is the one explicit, Admin-confirmed job; a kept, approved suggestion that holds a contact or
  an unshown name and has a link owes `scrub-identity` at once instead of after `closedDays`
  (`identity_scrub_due`, mirrored by `retentionStep` with `linked`, and listed by the dry run through
  `details->conversions`). The step clears the contact and the unshown name, keeps the links and
  everything else, raises the version and writes its audit event. Nothing clears on its own at
  conversion time, so an editor who linked it by mistake loses nothing until they run retention.
- **Nothing is published automatically.** No outcome, standing or link writes any page, feed, export
  or public file, and `published` is `false` for the kind in every state.
