# ADR 0192: A curated reference or annotation selects only a source that is already public

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0044](0044-what-a-citation-makes-public.md)

## Context

The source library is private and holds every source the author has ever recorded, cited or not.
A reference selection publishes a source's public description. If any source of the library could
be selected, selecting would approve it: a source the author never cited would become public by
the act of curating, which ADR 0185 forbids.

## Decision

- **Already public means one of three things.** A source is public when a published post cites
  it, when the Knowledge Atlas projection publishes it (it is cited, attributed or stood for by a
  published item), or when a published comparison's projection does. Nothing else is: not
  existing in the library, not being a claim's evidence, not being linked from a note.
- **A reference or a source annotation may select only those.** Selecting any other source is
  refused with `target-not-published` and a message that the source stays private and that
  selecting never approves it. A selection stored earlier whose source stopped being public (the
  post stopped citing it) is withheld as `not-approved` with the same message, so nothing is
  published of it.
- **The set is computed from what the build holds.** `boundary::public_sources` reads the cited
  keys of the published posts and the sources of the two projections, never a private file. A
  basis that names no public sources selects nothing.
- **Dependencies are not restricted again.** A relationship's, dating's or comparison's sources
  are public because the projection that published the item published them (ADR 0188).
