# ADR 0232: A comparison page is static HTML from the projection, with levels as sections a selector only enhances

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#90](https://github.com/journey-to-code-org/open.blog/issues/90)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0228](0228-an-audience-explanation-is-a-supplement-for-one-level-and-never-replaces-canonical-prose.md),
  [ADR 0230](0230-the-public-comparison-is-one-allowlisted-projection-of-approved-text-and-public-evidence.md)

## Context

ADR 0230 defined the one public comparison value and left it unread. This is its first reader. A
reader must be able to see who advances each reading, switch among the author's explanation levels,
and never find that the quoted evidence moved. The page has to be complete without JavaScript, and
nothing private may reach it.

## Decision

- **Opt in, at its own address.** `interpretations.publish` (off by default) publishes
  `/interpretations/` (an index, only while a comparison is published) and
  `/interpretations/<slug>/`. `/comparisons/` already belongs to passage comparisons (ADR 0092), so
  the new type does not share it. While the switch is on, a page or `postPath` at
  `/interpretations/` is refused by the build; off, nothing is reserved and `content/comparisons` is
  only edited.
- **Pages read the projection only.** A page is rendered from `PublicInterpretations`, built from
  `PublicComparison::project` and nothing else. The stored file is never read by a renderer. A draft
  has no page and is not reported; anything left out of a published comparison is reported to the
  author by comparison and item id, never by value.
- **What counts as public evidence.** Only an approved link of an approved claim, and the source it
  cites, and only while `claimEvidence.publish` is on. A comparison cannot publish a source the
  claims do not already publish. This is deliberately narrow and may be widened later, but never to
  a private link.
- **The attribution gap is closed.** `project` withholds an interpretation attributed to a source
  that is not public (`AttributionNotPublic`) instead of writing the source id. A reading cannot be
  shown without saying who holds it, so it is left out whole, with its relations and explanations.
- **Order and structure.** The page reads interpretations, then relations, then explanations. Each
  interpretation says who advances it (`Advanced by`, `Advanced in`, or an unknown author in the
  author's words), how firmly the author attributes it, its statement, uncertainty, provenance label
  and evidence. Statements keep their `lang` and `dir="auto"`; names are `<bdi>`.
- **Levels are sections.** Each level that has explanations is a section with its own id, linked
  from a list of links. All of them are on the page without JavaScript. An AI-drafted explanation
  carries its label and who approved the exact text.
- **The selector only enhances.** `<ob-explanation-levels>` replaces the list of links with buttons
  that carry a pressed state, starting at "All levels" so nothing is hidden until the reader
  chooses. It hides other level sections with `hidden`, announces what is shown in a polite status
  line, never moves focus, stores nothing, shows a level when a link targets it or something inside
  it, and print shows every level. Evidence sits outside every level section, so no choice can
  change it.
- **Raw files are never copied.** The static and theme copiers skip `<content>/comparisons`, so a
  `static` of `.` cannot serve a draft or an unapproved AI draft as a file.

## Consequences

- The publication boundary manifest, search, feeds and export do not yet list comparisons; #91 adds
  them and must read the same `PublicInterpretations`.
- A hand edit can still add an approval to the author's own file; the build does not verify who
  approved (ADR 0231).
