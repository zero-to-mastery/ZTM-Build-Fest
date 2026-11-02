# ADR 0209: A path is one line of steps with no branches, no repeats and no path inside a path

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#76](https://github.com/journey-to-code-org/open.blog/issues/76)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0207](0207-a-reading-path-is-its-own-content-type-and-never-a-series.md),
  [ADR 0170](0170-queries-are-exact-lookup-and-a-bounded-trail-that-infer-nothing.md)
- Contract: [Reading paths](../specs/reading-paths.md#steps)

## Context

Story B4 says paths are "explicitly ordered and curated" and the task's tests cover ordering, a
branches policy and cycles. A reader follows a path with Previous and Next, may keep progress
locally (#78), and an export must round trip (#79). A graph would need a way to say which branch a reader
is on, would let a path loop, and would make "why does this follow" ambiguous. The Knowledge Atlas
trail (ADR 0170, 0175) already is the place for exploring a graph of relationships, bounded and
list-first.

## Decision

- **One ordered list.** `steps` is the order, as written. Position is derived (one-based among the
  published steps) and never stored, so reordering is moving a step in the list.
- **No branches.** A step has one transition (from the step before it) and no list of next steps.
  A field that tries (`next`, `branches`) is, like any field this release does not define, kept
  as an inert extra (ADR 0208): it is never read, so it cannot make a branch, and the list is the
  order. Alternative routes are separate paths that happen to share steps. Optional material is a
  step marked `optional`, which a reader may skip, which never changes the order and which is never
  the first step. A step after an optional one follows the last required step (ADR 0210). This is reversible: a later version could add
  named branches without changing what a version 1 file means.
- **No repeats.** A target (post or atlas entry) appears at most once in a path. Revisiting one is
  a cycle in everything but name, makes progress and "previous" ambiguous, and is refused naming the
  later step and the earlier one.
- **No path in a path.** A step targets a post or an atlas entry and nothing else, so paths cannot
  reference one another and cannot cycle across files. A target of kind `path` is refused as an unknown
  kind. A series cannot be a step either; its posts can (ADR 0207).
- **Bounded.** At most 100 steps, so a page, a list and a progress record are bounded.
- **Incomplete drafts are allowed, malformed ones are not.** A draft may lack transitions or have
  fewer than two steps so Admin can save work in progress. Everything that is a shape, text,
  identity or repeat rule still applies to it. A published path has at least two steps and a
  transition on every step after the first.

## Consequences

- Previous and Next, a numbered list, local progress and a flat export all follow directly.
- An author wanting a "choose your own route" makes two paths and may link them from prose.
- Walking the atlas graph stays in the atlas trail.

## Domain language

**Reading path** and **Path step** are defined in [`CONTEXT.md`](../../CONTEXT.md).
