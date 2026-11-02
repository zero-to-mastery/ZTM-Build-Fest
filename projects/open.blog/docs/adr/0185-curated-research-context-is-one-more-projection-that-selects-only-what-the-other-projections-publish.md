# ADR 0185: Curated research context is one more projection that selects only what the other projections publish

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md), [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md), [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md)

## Context

Readers should be able to get a curated slice of the research behind a post (sources, entries,
relationships, datings, comparisons, and the author's own comments) without the research
workspace becoming public. The boundary of ADR 0125 already says what each projection publishes
and why everything else stays private. A second approval system, or a second projection pipeline,
would let the two disagree about what is public.

## Decision

- **A selection is a projection under the same boundary, not a parallel system.** It is one more
  `Projection` (`curated`, switch `curatedContext.publish`, off by default) in the same
  `BoundaryManifest`, with items of kind `selection` and the same withheld-reason vocabulary.
- **Selecting never approves.** A selection can only pick what the atlas, comparison and
  source-library projections already publish: an approved entry, a projected relationship, a
  projected dating, a published comparison, or a source's public description
  (`public_reference`). Selecting a private, unapproved or unprojected item is refused with
  `target-not-published`, naming the id only. A source is selectable only when it is already
  public: cited by a published post, or published by the atlas or a comparison (ADR 0192). A
  library source nothing publishes is private even though it exists, and selecting it does not
  change that. Approval stays where it was made (ADR 0058, 0092,
  0099); withdrawing it there withholds every selection of the item at the next resolve.
- **Nothing is public because it exists.** An empty selections file, a missing file and a switch
  that is off all publish nothing. A selection of an item publishes only the fields the selection
  lists (ADR 0187).
- **Private by file.** Selections live in `.openblog/private/research/selections.json`, a private
  store like the others (`Store::Selections`, guarded by the text guard, never copied to a public
  folder, listed under what is never published). Selecting, withdrawing and unselecting never
  write the objects they select.
- **Resolution reads the build's values.** `curated_selection::resolve` takes a `Basis` of the
  `PublicAtlas`, `PublicComparisons` and `SourceLibrary` the build already holds, the ids of the
  public sources and the slugs of the published posts. The private atlas and alignments are read
  only to tell a deleted item from an unapproved one (`Existing`). Existence is tracked per
  store: a store that was not read says nothing about what it holds, so an item of it is
  `private-dependency`, never `missing-target`.
- **One lock order.** Every store takes its locks in one order, and the selections file extends
  it: atlas, claims, alignments, notebook, library, selections. A selections write reads the
  atlas, the alignments, the notebook and the library to resolve what it selects, so it takes
  those locks first, in that order, then its own; it never takes the claims lock, and no other
  writer takes the selections lock, so no two writers can wait on each other. An Admin curation
  request holds the content lock before any of them (ADR 0195). A change to a store it reads only
  ever makes a selection stale, which withholds it.

## Consequences

- The Admin preview ("What will be public"), `check` and `build` describe curated context with
  the one manifest.
- A site must publish the atlas or comparisons projection for their items to be selectable; a
  source reference needs only the library.
- This ADR does not write public pages or a curated-context file: #197 renders the
  `PublicCuration` value, and #196 adds the Admin curation surface.
