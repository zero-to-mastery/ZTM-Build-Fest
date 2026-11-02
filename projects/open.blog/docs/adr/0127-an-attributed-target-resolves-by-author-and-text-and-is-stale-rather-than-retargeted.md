# ADR 0127: An attributed target resolves by author and text, and is stale rather than retargeted

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#212](https://github.com/journey-to-code-org/open.blog/issues/212)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0077](0077-targets-resolve-as-current-reanchored-or-stale.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md)

## Context

After edits a reader must reach the intended author's section, or be told honestly that it is gone,
and never be shown different words as if they were the ones read.

## Decision

`AttributedSections::resolve` is a pure function of the target and the sections as published now:

- **Current**: the author has a section whose text digest equals the one read. It reports where it
  is now and whether it moved (reordered, other sections added or removed, layout changed). If two
  of the author's sections hold identical text, the one at the place the reader saw is meant.
- **Stale** with a reason, and the author's published name when the author still has sections:
  `section-changed-or-removed` (the author still has sections but none with that text; the
  published work cannot say whether one was edited or removed, so neither is claimed),
  `author-absent` (no section by the author at all, in which case no author is named), or
  `ambiguous` (identical sections, none at the reader's place).
- **Never another author and never other text.** The author comes from the target and the text from
  its digest; the place is only a tie-breaker. A stale target is not retargeted to the nearest
  section, to the author's other sections, or to the work, and the reader's own words keep the
  context they were written in.
- `Standing::target_status` maps this to RD10's `TargetStatus` (stale carries whether the author
  still has a section), so the one vocabulary is reused and #224 renders no second one. The
  attributed digest has its own label (`openblog-attributed-section-v1`), not B5's
  `openblog-passage-section-v1`, so RD10's existing projection, which digests heading sections,
  does not resolve an attributed target as current by accident. Wiring the page to link a
  reflection to its section, and to show answers, is #224's job. #223 wires only the status: the
  projection resolves an attributed target through `AttributedSections` and the page names the
  author and never links the section (ADR 0135), so an approved reflection is never shown as
  "revised or removed" when its section is unchanged.

## Consequences

Resolution is deterministic and independent of layout. Draft revision numbers are not needed: the
digest is stronger than a number and survives publishing again.
