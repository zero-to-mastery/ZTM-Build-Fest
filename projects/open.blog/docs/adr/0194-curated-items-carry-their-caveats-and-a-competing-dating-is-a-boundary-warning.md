# ADR 0194: Curated items carry their caveats, and a competing dating is a boundary warning

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0188](0188-a-selection-brings-the-minimum-approved-context-it-needs-and-fails-alone-with-an-item-scoped-diagnostic.md), [ADR 0189](0189-imported-metadata-keeps-the-provenance-the-author-states-and-a-missing-detail-is-listed-never-invented.md)

## Context

Three notices were computed and then dropped before anyone saw them: a competing dating that is
published but not selected, a selected detail the source lacks, and imported metadata whose origin
was not recorded. Each is something an author should look at and a reader should not be misled
about.

## Decision

- **`competing-unselected`, `missing-detail` and `provenance-unrecorded` travel with the item.**
  `CuratedItem.notices` lists them with their field and a message that names ids and fields only;
  the public value a page renders carries them, so what the author is told and what a reader can
  be shown agree. The other three notices (`unsafe-url`, `private-identifier`,
  `rights-restricted`) are withheld fields of the item and stay there.
- **The manifest and the previews list them.** A published curated item in the boundary manifest
  has a `notices` list, shown in What will be public, in What this post makes public and in the
  Selected for readers preview.
- **A competing dating is a `boundary:` warning** in `openblog build` and `check`, naming the
  selected dating and the rivals that are not selected. It never fails a build: showing one
  dating is the author's choice, made visible.
