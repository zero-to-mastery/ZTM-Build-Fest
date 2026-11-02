# ADR 0188: A selection brings the minimum approved context it needs and fails alone with an item-scoped diagnostic

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0186](0186-a-selection-records-the-revision-it-was-made-against-and-is-stale-when-that-or-anything-it-depends-on-changes.md), [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md)

## Context

A relationship without its endpoints and sources cannot be understood; a dependency that is
stale, missing or private must not silently drop or leak.

## Decision

- **Dependency closure.** Resolving a selection collects, from the public projections only, the
  approved context it needs, as `context` items beside the selected items (never repeated when
  the author also selected them): a relationship brings both endpoint entries (id, label,
  address) and every source it cites, is attributed to or is disputed with; a timeline brings its
  owner (and its endpoints for a relationship), a relative dating's entry and its sources; a
  comparison brings the sources of its versions, evidence and recorder; an entry brings the
  work's source; an annotation its source; an explanation its entry. A source comes as its public
  description (`public_reference`), so an unsafe web address or a private identifier is withheld
  with an `unsafe-url` or `private-identifier` notice. Each context item says which selections
  need it (`via`).
- **Requirements between selections.** `requires` names selections that must be published with
  this one, at most 32 of them. An unknown id is `private-dependency`; a withheld requirement
  withholds this selection (`private-dependency`), however far back the chain goes; a cycle of
  requirements withholds every selection on it (`selection-cycle`). Dependants are withheld,
  never deleted or changed. The members of cycles are the strongly connected components of more
  than one selection and any selection that requires itself, found in one iterative Tarjan pass,
  and a withheld selection reaches those that require it through a worklist, so resolving is
  linear in the size of the file, however hostile: 5,000 selections each requiring 32 others
  resolve in well under a second.
- **Failures are object-scoped, non-destructive and name ids only.** Each withheld selection has
  one reason and one sentence naming ids and fields, never text. Other selections resolve on
  their own. Parsing a file reports every record problem with its code, id and field; nothing is
  repaired in place.
- **A competing dating** of the same owner (by owner type) and aspect that is published but not
  selected gives a `competing-unselected` notice on the selected dating, so a reader is never
  shown one side of a disagreement by accident. The notice travels with the item (ADR 0194).
- **A dating names what it dates by its owner type.** A relationship-owned dating brings the
  relationship (and its endpoints) and says "relationship", an entry-owned one the entry; the id
  alone never decides.
- **Deterministic.** Selections, items, context and notices are sorted by id (context by kind
  then id); the file is written in id order with a trailing newline and LF endings.
