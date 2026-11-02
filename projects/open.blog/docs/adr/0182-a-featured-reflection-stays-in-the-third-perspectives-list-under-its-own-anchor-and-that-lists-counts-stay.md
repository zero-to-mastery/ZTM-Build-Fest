# ADR 0182: A featured reflection stays in the Third Perspectives list under its own anchor, and that list's counts stay

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
- Parent story: [#205](https://github.com/journey-to-code-org/open.blog/issues/205)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0180](0180-a-feature-says-whose-reflection-it-is-and-why-it-is-shown-and-nothing-counts-ranks-or-claims-consensus.md)
- Coordinates with: [#230](https://github.com/journey-to-code-org/open.blog/issues/230) (public section)

## Context

Review of #214 asked three questions the page task (#230) cannot answer alone: whether a featured
reflection is also kept in the Third Perspectives list and how a page then avoids a repeated id;
whether the counts the Third Perspectives section already prints sit with ADR 0180's rule that nothing
counts; and whether the section notice reads correctly for several features.

## Decision

- **A featured reflection is still listed in the Third Perspectives section.** The feature is a second
  placement of the same published reflection, not a move: that section is the complete, unselected
  record of what was approved, so removing items from it would make featuring look like promotion
  and would let a take-off change what the unselected list holds. Featuring never edits
  `third-perspectives.json`.
- **A feature has its own anchor, so no id repeats.** The Third Perspectives section keeps its
  `ob-perspective-<id>` article id (and `-title`). The community section's element for the same
  reflection is `ob-feature-<id>` (and `ob-feature-<id>-title`), from `feature_anchor`. A link to
  `#ob-perspective-<id>` (an abuse report, an older link) still lands in the full list. #230 renders
  each feature with its own anchor, and renders the section as a `<ul>` (ADR 0180).
- **The Third Perspectives section's counts stay, and the community section has none.** The section
  prints "N reader reflections on this section" and "N reflections about…" (`perspective_publication.rs`).
  Those count what is printed beneath them on the same page, of every approved reflection with no
  selection, never rank or order anything, and never state a total for the site, a share of those
  received or any reaction; they tell a reader how long the list under the heading is. They are not a
  popularity signal. ADR 0180's rule applies to a selection, where a number (how many are featured,
  how many were received) would tell readers how the editors weigh the rest, so the community section
  says no number at all. This keeps RD10's output byte for byte.
- **The notice is plural.** `NON_CONSENSUS_NOTICE` reads "these reflections … Each is one reader's view"
  because a section may hold several; it is accurate for one.

## Considered options

- **Remove a featured reflection from the full list.** Rejected: it changes what the unselected record
  holds and makes featuring a promotion.
- **Reuse `ob-perspective-<id>` in the community section.** Rejected: a repeated id breaks fragment links
  and assistive technology.
- **Drop the existing counts.** Rejected: they describe the visible list and are not a signal; removing
  them would change every existing page for no honesty gain.
