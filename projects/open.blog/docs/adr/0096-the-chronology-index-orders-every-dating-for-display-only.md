# ADR 0096: The chronology index orders every dating for display only

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#57](https://github.com/journey-to-code-org/open.blog/issues/57)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0093](0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md),
  [ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#chronology-index-and-prompts)

## Context

ADR 0093 gave every dating a display key (`DateExpr::key`) and kept competing datings side by
side. Admin exploration (#58), publication (#59) and the structural prompts (ADR 0097) all need
the same lookups: an entry's datings by aspect, every dating of one aspect, and one timeline. If
each surface sorted for itself, two views of one atlas could order partial dates differently, and
a convenience such as "show the most likely date" or "group contemporaries" could creep in.

## Decision

- **One index, `openblog_core::chronology_index::ChronologyIndex::of(&Atlas)`.** It reads a
  validated atlas and never fails or writes. It holds every dating by id (its owner, aspect and
  key); `by_owner` (each entry's or relationship's datings by aspect); `by_aspect`; `by_time`
  (one timeline); and `relative_to` (the relative datings that point at each entry).
- **One order everywhere.** Every list is in `chronology::chronological` order: earliest stated
  day, then latest (an open start before every year, an open end after every year), then
  relative datings, then unknown ones, ties broken by dating id. Since ids are unique the order
  is total, and the index is the same whatever order the file lists entries or datings in.
  Circa does not move a point and no calendar is converted.
- **Nothing is dropped or chosen.** A group in `by_owner` with more than one dating holds
  competing datings side by side (`ChronologyIndex::competing`). Circa, relative and unknown
  datings are all indexed; an entry with no datings has no index entry and is simply undated.
  There is no preferred, merged, averaged or "best" dating anywhere in the index.
- **Order is not a relationship.** The index lists only datings someone recorded. It has no
  table of neighbours or contemporaries, never derives a relative dating from absolute ones, and
  never touches relationships: `Atlas::relationships_of` reads the same before and after.
- **Private and approved alike.** The index covers every dating, so it is for the author's
  tools (`check`, Admin). A public surface must read only projected datings
  (`Atlas::projected_datings`, ADR 0095); the index is never published.

## Consequences

- #58 and #59 can list, filter and lay out chronology from one deterministic source without
  re-sorting, and cannot disagree about where a partial date falls.
- A timeline that would want to collapse competing datings into one bar has to show each.
- Changing the order is a change to `DateExpr::key` or `chronological`, in one place.

## Domain language

**Chronology index** is defined in [`CONTEXT.md`](../../CONTEXT.md).
