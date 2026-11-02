# ADR 0171: The query file carries the pages' wording and a work's source, and its lookup is one shared algorithm

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#72](https://github.com/journey-to-code-org/open.blog/issues/72)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0169](0169-the-query-projection-is-bounded-clips-text-visibly-and-is-refused-whole-over-a-bound.md),
  [ADR 0170](0170-queries-are-exact-lookup-and-a-bounded-trail-that-infer-nothing.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#query-projection)

## Context

Review of the first query projection found four gaps that #73 to #75 would otherwise paper over in
JavaScript. A work's own provenance (`PublicEntry.source`) was dropped, so a component could not
say what a work entry stands for. Components would have had to re-implement the wording the Rust
pages use for kinds, confidence, standing, who asserts a position and how evidence reads, and
wording that drifts between the page and the preview is a way of saying two different things about
the same relationship. A refusal for an inconsistent atlas shared the over-limit reason, which tells
an author to look for a size problem that is not there. And the lookup's normalization was described
as "whitespace and case", which JavaScript and Rust implement differently at U+0085 and U+FEFF.

## Decision

- **A work's source is kept.** `QueryEntry.source` is the id of the source a work entry stands for.
  It is cited into `sources` (so its public text is in the file, even when no relationship cites it)
  and listed among the entry's copied fields in the boundary manifest.
- **Display text is computed once, in Rust.** The file carries `kindLabel` on an entry, and on a
  relationship `assertedByText` (the site author's public name for an author-asserted position, a
  source's public title, or the named party, exactly as `PublicAtlas::party_text`), `confidenceText`,
  `standingText` (including that no recorded disagreement is not agreement) and, on each evidence
  item, `text` (`PublicAtlas::evidence_text`). The machine values stay beside them. A component shows
  the text and never rebuilds it. `AtlasQuery::project` therefore also takes the author's public name,
  and the site's base path (for the size bound below); both are public site configuration, not
  research.
- **Added optional fields stay at format version 1.** The format is unreleased: no release has
  written `atlas-query.json`, so nothing reads it yet that could be broken. From the first release
  that writes it, adding an optional field is not a version change and a reader ignores fields it
  does not know; removing or renaming a field, or changing what one means, raises `formatVersion`.
- **Two refusal reasons.** A count or size bound is `over-limit`. A published atlas that does not
  agree with itself (a non-slug or duplicate id, an edge to an unpublished entry, an uncited
  relationship, an unpublished source, an unsafe address) is `inconsistent`, with its own Admin
  label. Either leaves the file out whole, prints a `boundary:` warning with the message in the build
  (a silent omission would leave a component to guess why a trail is missing), and leaves the pages
  and `atlas.json` as the complete fallback.
- **The boundary check follows every pointer.** The final output check refuses the file if any entry
  or source it names is not one the manifest lists for the query projection: `edges[].from` and `to`,
  `terms[].entries`, `sources[].id`, `evidence[].source`, `assertedBy.source` and `entries[].source`,
  as well as the ids of the entries and edges themselves. The manifest lists each source the file
  holds as a `source` item.
- **One lookup algorithm.** A term is the text split on Unicode `White_Space`, joined with single
  spaces and lowercased with the default Unicode case conversion (`str::to_lowercase`,
  `String.prototype.toLowerCase`). There is no normalization form: a composed and a decomposed
  spelling of the same letters are different terms, and `ß` is neither folded to `ss` nor equal to
  it. This is the one rule that Rust (`normalize_term`) and `web/components/atlas-terms.js` share, and
  both are tested against `tests/fixtures/atlas-lookup.json`, which includes `Straße`, composed and
  decomposed `Café`, U+0085 (white space, which JavaScript's `\s` does not match) and U+FEFF (not
  white space, which `\s` does match). NFC normalization of labels at validation was rejected for now:
  the tree has no direct normalization dependency (only transitive ones), a new dependency is not
  warranted for this, and an author who wants both spellings findable can add the second as an alias.
- **The size bound is the size as published.** See ADR 0169: the 4 MiB limit counts the base path the
  build puts in front of every address.

## Consequences

- #74 and #75 render `text` fields and never restate Rust wording; the pages and the previews cannot
  disagree about how firmly a position is held.
- A site whose editor or importer produces decomposed text finds it only by decomposed lookup; the
  fixture records that choice so it can be revisited deliberately.
- The file grows by the display text; the byte bound and the clip rules still apply.
