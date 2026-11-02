# ADR 0085: Rights are the author's declaration for each version, unknown until stated

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#52](https://github.com/journey-to-code-org/open.blog/issues/52)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0062](0062-media-moments-locate-attributed-quotations-and-observations.md),
  [ADR 0065](0065-precise-quotation-attribution-and-rights-guidance.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

Story #22 requires rights warnings that prevent accidental public reproduction, and #55 will
publish brief excerpts only with an explicit rights status. Rights differ between versions of
the same work: an ancient work is out of copyright, a modern critical edition or translation of
it may not be, and a library's digitized manuscript may carry an open licence. open.blog cannot
and must not decide what is permitted. Media moments (ADR 0062, 0065) already record a
quotation's rights as the participant's own statement and never a legal determination.

## Decision

- An edition, translation, or witness may carry **`rights`**: `{ "status", "note"?, "license"? }`.
  A work has no text of its own and a reference only points into a version, so neither may carry
  rights; declaring them there is refused with a pointer to the version.
- **Statuses** are the author's own statement about the version's text: `unknown`,
  `rightsReserved`, `permission`, `openLicense`, `publicDomain`, and `ownWork`. The tags follow
  the camel case of quotation rights. A declaration must name a status; `license` (a licence
  name or identifier, kept as text and never resolved) belongs only with `openLicense`; `note`
  is one line, such as why the author believes the text is in the public domain.
- **Unknown is explicit and the default.** `SourceRecord::rights_status` returns the declared
  status or `unknown` for any version that declares none, and nothing for a work or reference.
  A status is never inherited: a revised edition, an edition of a translation, or a translation
  of a public-domain work each starts as unknown. Interpretations (ADR 0087) carry the same
  declaration for their own text.
- **Labels never grant permission.** Every label reads as what the author states ("The author
  states the text is in the public domain"), and no code path turns a status into "allowed".
- **Private.** Declarations stay in the private library. The public reference description is an
  allowlist that excludes them, BibTeX export omits them and says so, and only an author's own
  CSL JSON export of the library carries them, as it carries everything.

## Consequences

- #54 can show a version's rights status next to every passage and #55 can require one before
  publishing an excerpt, both reading one field instead of guessing from dates.
- Authors must state rights per version; a library that never does reads as unknown everywhere,
  which is the honest, conservative answer.
- open.blog makes no copyright determination, now or later, from these fields.

## Domain language

**Rights declaration** and **Rights status** are defined in [`CONTEXT.md`](../../CONTEXT.md).
