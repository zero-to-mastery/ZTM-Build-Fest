# ADR 0186: A selection records the revision it was made against and is stale when that, or anything it depends on, changes

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md), [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md)

## Context

Approval of a comparison already goes stale when a passage's locators move (ADR 0125). Curation
needs the same honesty for everything it selects: the author chose one version of an item.

## Decision

- **Identity.** A selection has a stable lowercase-slug `id` (derived as `<kind>-<target>` and a
  short hash of the exact kind and target unless given, so two targets whose readable forms
  collide, or a long target that is cut, never derive the same id), a `kind` and a `target`. The kinds keep the research model's distinctions apart:
  `reference` (a source's public description, never a citation), `contextual-entry`,
  `relationship`, `timeline` (one dating), `comparison`, `source-annotation` and `explanation`
  (the author's attributed words about a source or an entry).
- **Revision.** The `revision` is a 64-bit FNV-1a fingerprint, as 16 hex digits, of a canonical
  list of explicit name/value pairs, each length-prefixed so no two lists feed the hash the same
  bytes: the kind and target, the whole selected public item (not only the listed fields), the
  listed `fields`, the `provenance`, the author's `text`, `by` and a listed `locator`, the sorted
  `requires`, the `posts`, and every public dependency the item brings (ADR 0188), recorded
  when the author selects. Where the item sits among a post's items (`positions`, ADR 0193) is
  presentation, not content, and is deliberately not in it. Every choice about what readers are
  given is in it, so changing one is a change to what was selected; it is computed from the projections' public values, never
  from private notes. A fingerprint is only compared with one made by the same engine: an
  upgrade that changes how an item is projected may make selections stale, and the author
  selects them again. Nothing re-records a revision on its own.
- **Stale.** A live selection whose current revision differs is withheld as `stale-selection`,
  alone, with an item-scoped message and a `boundary:` warning. It is neither dropped nor
  updated: the old revision is never published. The author checks the item and chooses
  `reselect`, which records the revision as it now stands (the idiom of "Checked - approve
  again", ADR 0125). Nothing re-records a revision on its own.
- **Missing and unapproved.** A target that no longer exists is `missing-target`; one that
  exists but is not published is `not-approved`; when that cannot be told apart,
  `private-dependency`.
- **Reordering is not checking.** Changing the posts a selection is for recomputes its revision,
  since the scope is part of it, but only from a current one: the change is refused with
  `stale-selection` while the selection is stale, so scoping never re-blesses an item that
  changed. Ordering never touches the revision (a place is not part of it), and an ordering
  that lists a stale selection is refused for the same reason, so it is never ordered past its
  check.
- **Withdraw and unselect.** Withdrawing keeps the record with an optional reason and publishes
  nothing (`withdrawn`); `reselect` makes it live again against the current revision. Unselecting
  removes the record. Neither touches the selected research.
