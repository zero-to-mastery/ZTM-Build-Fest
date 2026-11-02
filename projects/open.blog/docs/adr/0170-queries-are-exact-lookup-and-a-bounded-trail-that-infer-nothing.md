# ADR 0170: Queries are an exact term lookup and a bounded trail, and infer nothing

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#72](https://github.com/journey-to-code-org/open.blog/issues/72)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0169](0169-the-query-projection-is-bounded-clips-text-visibly-and-is-refused-whole-over-a-bound.md)

## Context

#72 puts "arbitrary graph queries" and a public write API out of scope, and the story puts open-web
entity extraction and inferred relationships out of scope. What remains is a small, fixed set of
read operations that #73 (linking prose to entries), #74 (previews) and #75 (relationship trails)
need, with defined behaviour for ambiguity, unknown ids and cycles.

## Decision

- **A closed set of operations** on `AtlasQuery`, all read-only over the projection: `entry`,
  `edge` and `source` by id; `lookup` by term; `edges_of` an entry; `trail` from an entry. There is
  no query language, no path search between two entries, no filtering by a property and no ranking.
- **Lookup is exact after normalization.** A term is the text split on Unicode `White_Space`,
  joined with single spaces and lowercased, nothing else (the exact rule is ADR 0171's): no stemming, translation, transliteration or fuzzy match. It matches an entry's label or
  alias. When two entries share a term, both are returned in id order and nothing picks one:
  choosing is the author's explicit link (#73), not the machine's. Prose is never scanned.
- **A trail is a bounded breadth-first walk over published relationships**, across either
  direction, from one published entry. Each step names the relationship, whether it was crossed
  `forward` (`from` to `to`, as stored) or `backward`, and the entry reached. A relationship is
  crossed once and an entry expanded once, so a cycle ends the walk instead of trapping it, and a
  step that closes a cycle is still shown as the relationship it is. Order is fixed: by depth, then
  by the order entries were reached, outgoing before incoming, each by id. The walk stops at depth
  3 or 50 steps and reports `truncated` when more existed.
- **A trail means nothing beyond its steps.** It is not a path of influence, a derivation or a
  ranking. It does not combine relationships into a new one, infer a missing one, assume that
  `related-to` is transitive, or treat proximity as strength. Each step carries its own asserter,
  confidence, standing and uncertainty, which a component must show with it.
- **Unknown ids answer nothing.** An id the projection does not hold (including every private or
  withdrawn item) returns no entry, no edges and an empty trail, with no error text that could
  confirm the item exists.

## Consequences

- #75 renders a trail as a semantic list from `trail` data and can mark a cycle by seeing an edge
  whose reached entry it has already shown.
- Anything richer (path search, filters, relevance) needs its own decision and, if it reads more
  than the published atlas, a new projection.
