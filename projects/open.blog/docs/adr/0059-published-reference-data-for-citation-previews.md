# ADR 0059: Previews read one inline reference document projected from the published citations

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#64](https://github.com/journey-to-code-org/open.blog/issues/64)
- Parent story: [#25](https://github.com/journey-to-code-org/open.blog/issues/25)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0042](0042-citation-keys-are-source-identifiers.md),
  [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md)
- Contract: [Citation format](../specs/citations.md)

## Context

A3 publishes citations as footnotes whose notes are the visible references. B1 adds a preview
that shows a reference beside its marker (#66), no-JS anchors (#65) and later stable passage
targets (#80) and reader annotations (#84), which will name references and markers. They need
ids they can rely on and one agreed data shape, without a second model of what a citation makes
public.

## Decision

- **One document, projected, not parallel.** `ReaderReferences` is built from the
  `CitationSummary` the load already keeps, so it holds `PublicReference` and `PublicLocator`
  values only (ADR 0044). It adds no source field, and no summary, score or claim about a source.
- **Stable reference id = the citation key** (ADR 0042). It is distinct for each work, edition,
  translation and witness, so versions never share an id. The reference carries `kind`; the
  `of` relationship stays private. `number` is the order of first citation.
- **Location is the citation's, not the reference's.** Each citation lists its `locators`
  (kind, value, end) next to the reference id, so "which edition" and "where in it" never blur.
- **Anchors are the ones the page already has.** A citation names its `marker` id
  (`cite-N-ref-K`) and its `note` id (`cite-N`), using the post's generated label prefix, which
  already avoids the author's footnotes. `check_page` confirms the page holds each. Without
  JavaScript the marker links to the note, which is the visible reference.
- **Marker and note ids are positional, for one revision only.** `N` is the order of first
  citation, `K` the occurrence, and the prefix depends on the author's own footnotes, so adding,
  removing or reordering a citation (or adding a footnote named like ours) renumbers them. They
  tie the data to the page it is embedded in and must not be stored or linked to from elsewhere.
  A durable target is the reference `id`, or, for a place in the text, the passage and
  annotation selectors of #80 and #84.
- **Preview fields**: `preview` (the allowlisted description), `formatted` (the plain-text
  rendering), and `link`, a DOI resolver address or a plain HTTP(S) address without
  credentials, else absent.
- **Where it lives: inline in the page only.** One
  `<script type="application/json" id="ob-references">` element, written with `<`, `>`, `&` and
  U+2028/9 escaped so no text can close it. Not a separate file in `dist`, in version 1: a page
  is then self-contained and consistent with its own notes, works from a file or any static
  host, and needs no fetch, CORS or cache rule. A JSON file can be added later without changing
  the document, because it is the same value. Portable copies, feeds and `llms.txt` do not carry
  it; their notes already are the references.
- **Opt-in and deterministic.** Only a post that publishes citations has the document. Field
  order is fixed, the CSL map is ordered, and nothing depends on time or locale. Versioned
  (`version: 1`); a consumer ignores a higher one.
- Emitting the element in the page template and the component are #65 and #66.

## Consequences

- Later stories can refer to a reference by its id without re-deriving it; a marker or note id
  is only meaningful within the page revision that carries the data.
- Adding a source field never reaches a preview until it is added to the ADR 0044 allowlist.
- Inline data repeats reference text already in the notes; pages that cite a lot get larger.

## Domain language

**Reader references** is defined in [`CONTEXT.md`](../../CONTEXT.md).
