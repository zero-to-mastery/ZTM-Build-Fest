# ADR 0169: The query projection is bounded, clips text visibly and is refused whole over a bound

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#72](https://github.com/journey-to-code-org/open.blog/issues/72)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md)

## Context

Page data that components load must be small and predictable, and #72 asks for size bounds and
unsafe-address tests. But a relationship's doubt and an entry's summary are the author's words
about real people: cutting them silently would change what they say, and dropping half of an atlas
would make a reader's trail look complete when it is not.

## Decision

- **Bounds, in the module, as constants:** 2,000 entries; 10,000 relationships; 240 characters of
  preview or uncertainty; 50 listed relationship ids per entry per direction; lookup terms of at
  most 80 characters; 4 MiB serialized; trails of at most 3 steps deep and 50 steps. The limits a
  reader may rely on (text, listed edges, trail depth and steps) are written into the file as
  `limits`.
- **Counts and size are refused whole, never truncated.** An atlas over the entry, relationship or
  byte bound, or inconsistent (an unsafe address, a non-slug or duplicate id, an edge to an
  unpublished entry, an uncited relationship, an unpublished source), gets no query file. The
  refusal names the limit, or ids, and never an item's text or an offending address. `atlas.json`
  and the pages are unaffected and remain the complete fallback, so this is not a build failure:
  the build leaves the file out and prints a `boundary:` warning with the sentence, and Admin's
  manifest shows the withheld `atlas-query` item with the sentence and a reason that tells the two
  apart: `over-limit` for a count or size bound, `inconsistent` for an atlas that does not agree
  with itself.
- **The byte bound is the size as published.** The build writes the file after prefixing every
  root-relative address with the site's base path, so the 4 MiB bound is checked with that prefix
  counted (the build also checks the written file), not on the unprefixed text.
- **Text is clipped visibly.** A preview is the first paragraph of the published summary, with
  whitespace collapsed, cut on a character boundary with an ellipsis, and never between a base
  character and the combining mark, variation selector or joiner that follows it (the base goes
  too; only the common extender ranges are recognised, so a script whose marks lie elsewhere can
  still be cut between a base and a mark). `previewClipped` is true
  whenever the preview is less than the whole summary (cut, or more paragraphs follow), and
  `uncertaintyClipped` whenever the doubt was cut, so a component says "continued on the page" and
  links to the entry. Uncertainty is never dropped, only shortened with that flag.
- **Listing is bounded, the data is complete.** An entry lists at most 50 relationship ids each
  way and counts the rest as `moreOut` and `moreIn`; the `edges` array still holds every
  relationship, so no relationship disappears from the file, and the page lists them all.
- **Addresses.** A published address must start with `/atlas/` and contain no scheme or authority,
  `//`, `..`, backslash, query, control character, space or colon, and at most one fragment. Entry
  addresses must be exactly `/atlas/<id>/`.

## Consequences

- A very large atlas keeps working as pages and `atlas.json`; only the compact data is withheld,
  and the author is told why in the preview.
- The bounds are generous for a hand-written atlas. Raising them is a constants change plus a
  format note, not a format break.
