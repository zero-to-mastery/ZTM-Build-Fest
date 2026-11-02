# ADR 0166: Only a suggestion may have a page without a passage, and the rollback names the audit guard

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#227](https://github.com/journey-to-code-org/open.blog/issues/227)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0154](0154-a-suggestion-is-one-feedback-row-with-no-passage-target-and-one-loosened-check.md), [ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md)

## Context

[ADR 0154](0154-a-suggestion-is-one-feedback-row-with-no-passage-target-and-one-loosened-check.md)
loosened `openblog_feedback_passage_complete` so a row may have no revision and no target whatever its
`work`. That also let any other kind have a page and no passage, which no code writes and no reader
expects.

## Decision

- **The check names the kind.** It becomes `(revision is null and target is null and (work is null or
  kind = 'future-suggestion')) or (work is not null and revision is not null and target is not null)`:
  only a suggestion has a page without a passage; every other kind still has all three or none.
  Every row the original check allowed (all three null, or all three set, of any kind) satisfies it,
  so nothing stored changes; the file still drops and adds it, so it is idempotent. A test checks
  every kind against the original check.
- **The rollback restores the original check** and still refuses while a row has a page and no
  passage, which the tightened check makes exactly the suggestion rows. Its header now says that
  `protection.sql`'s `openblog_feedback_events_keep_recent` trigger refuses to delete an audit event
  less than a day old (wait for the day; never drop the trigger), and that running `feedback.sql`
  again loosens the check again, so the rollback is run after the last run of that file.
- **Contact has two readers and no others.** The reader sees their own contact through their
  receipt (they gave it), and the site Admin through the inbox; no public route, no other Admin
  route and no audit event carries it, and a test asserts it for every route. The generic
  `PATCH admin/feedback` refuses a suggestion with `useModerationInbox`.
