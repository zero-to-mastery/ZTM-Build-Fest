# ADR 0207: A reading path is its own content type and never a series

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#76](https://github.com/journey-to-code-org/open.blog/issues/76)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0038](0038-shared-publications-join-the-existing-series.md),
  [ADR 0040](0040-contributor-aware-series-navigation.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md)
- Contract: [Reading paths](../specs/reading-paths.md)

## Context

B4 asks for optional editorial sequences that say why each step follows. The repository already has
series: ordered posts with navigation, a theme and, for shared work, contributors. The task asks
whether a path should extend series or stand apart, and the acceptance criterion says paths are
"distinct from series and preserve author intent".

A series is a property of a post. A post names at most one series (`series`, `seriesOrder`), the order is
the author's number or else the date, the page is generated from the posts that claim it, and a
series holds posts only. A path differs on every axis that matters:

- **Membership.** A post may sit in several paths, in a different order in each, and a path may
  hold atlas entries. A series cannot do either without changing the post's own front matter.
- **Authority.** A series order is derived from the posts. A path order is the author's
  statement and the only source of it.
- **Content.** A step carries a rationale, a prerequisite note, a difficulty and, after the first,
  a transition. A series has none of these and nowhere to put them.
- **Blast radius.** Putting paths in series would rewrite posts to join a path and change every
  series page and feed that already exists.

## Decision

- **A path is its own content type**, `content/paths/<slug>.json`, with its own parser, canonical
  writer and projection (`openblog_core::reading_path`). It does not extend series, add a field to a
  post, or add a kind of series.
- **Coexistence by independence.** A path never reads, writes or reorders a series, and nothing in a
  post changes when a path names it. A path may hold some, all or none of a series' posts in any
  order. A test builds a site with a series and a path that reverses it and asserts that the
  series order and every generated file are byte for byte unchanged.
- **Reuse where the seam is the same.** What a step points at is resolved against the posts a
  build publishes and the public atlas (ADR 0168 supplies the atlas), and a step's address is the
  target's own canonical address. A path invents no new notion of "published".
- **Not now: a series as a step.** A step cannot name a series. An author who wants a series in a
  path lists its posts. Adding a series target later is additive and does not change this file
  format's meaning.
- **Opt-in by existing.** A site with no `content/paths` folder builds exactly as before and every
  output is byte equal. The core change adds a module and no behaviour to existing code.

## Consequences

- Authors learn one more file type, and Admin (#77) gets a distinct editor rather than a series
  option that would hide the difference.
- A reader can be offered both a series and a path through the same posts without either lying about
  the other.
- The cost is a second small ordering concept. It is kept honest by being explicitly authored
  everywhere and never inferred.

## Domain language

**Reading path** and **Path step** are defined in [`CONTEXT.md`](../../CONTEXT.md).
