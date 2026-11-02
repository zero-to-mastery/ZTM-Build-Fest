# ADR 0197: The curated context file is a bounded, versioned projection of the one public curated value

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#197](https://github.com/journey-to-code-org/open.blog/issues/197)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md), [ADR 0193](0193-a-selection-is-for-the-site-or-for-named-published-posts-in-the-authors-order.md)

## Context

Reader Discovery (#16, #25, #27) needs to enhance curated research context without reading a private
store or guessing which selections are public. ADR 0185 made the curated value public and previewable;
nothing yet wrote it where a reader's tool can fetch it.

## Decision

- **One file, from one value.** A site that publishes curated context writes `curated-context.json`,
  projected from `PublicCuration` and the published posts' slugs and addresses, and from nothing else:
  it takes no selections file, library, notebook or atlas, so it cannot name or reach a private object.
  An addition to what a selection publishes reaches the file only through the selection projection.
- **Versioned and self-describing.** `format` is `openblog-curated-context-file`, distinct from the public value's own `openblog-curated-context` and `formatVersion` is 1;
  `section` and `anchorPrefix` say where a post's section and an item's fragment are, so a consumer never
  guesses either. Each item carries the revision that was selected (the one published), its attribution,
  doubt, dissent and evidence, its provenance, the fields the source lacks (never invented) and its
  notices. A consumer that does not know the version declines.
- **Per post, in the author's order.** `posts` lists each published post that offers anything, sorted by
  slug, with its items in that post's own order (ADR 0193) and the canonical address of each.
- **Deterministic and safe to embed.** The same site builds the same bytes: every list has a defined
  order and the JSON is compact with `<`, `>` and `&` escaped, as the atlas files are.
- **Bounded, and refused whole.** At most 1 MiB (after the base path) and 2,000 posts. A projection over
  a bound, or that does not agree with itself (an item published twice, a requirement or context that
  names an item that is not published, an item naming a post the build does not publish), is left out
  whole with a `boundary:` warning that names the limit and ids, never text. The pages are unaffected.
- **Listed in the manifest.** The site manifest gains the `curated-context` projection (switch
  `curatedContext.publish`) with one item for the file, its address and the posts it lists, or the
  reason it is withheld. The build summary does not count it twice, as for the atlas query file.
