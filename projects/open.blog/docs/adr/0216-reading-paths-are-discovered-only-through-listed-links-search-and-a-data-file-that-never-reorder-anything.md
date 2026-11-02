# ADR 0216: Reading paths are discovered only through listed links, search and a data file that never reorder anything

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#79](https://github.com/journey-to-code-org/open.blog/issues/79)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0212](0212-the-public-paths-value-is-an-allowlisted-deterministic-projection-and-nothing-reads-a-path-yet.md),
  [ADR 0215](0215-a-published-path-is-a-static-ordered-page-with-optional-progress-kept-only-in-the-readers-browser.md)
- Contract: [Reading paths](../specs/reading-paths.md#discovery)

## Context

A path page is only useful if a reader can arrive at it. Posts and atlas entries are where they are
already reading, search is where they look, and tools want a data file. Each of those is a new place a path
could leak (an unlisted path, a draft step, an author id) or distort something that exists (the order of
posts, a feed).

## Decision

- **One rule, `listed`.** Every discovery surface reads `PublicPaths::listed_only()` or
  `PublicPaths::memberships()`, which skip unlisted paths. An unlisted path is published at its address
  and advertised nowhere: not `/paths/`, the sitemap, search, `paths.json` or a link from a post.
- **A link, not a claim.** A post or atlas entry that is a step of a listed path gets a section "Part of a
  reading path" after its content: the path's title, a link to the step (`#step-N`) and "step N of M". It
  says nothing about the item and adds nothing to its metadata. A post in no listed path has the very same
  page as before; a post in one differs only by that section.
- **Order is never touched.** Home, archive, series, related posts, previous and next links, feeds and
  the post order in search are computed from posts alone, exactly as before. Reading paths are not posts and
  carry no date.
- **Search.** Each listed path adds one entry after all post entries (`url` `/paths/<slug>/`, tag
  `reading path`, the author's summary, and the shown steps' titles, rationales and reasons as lower-cased
  text). It is built from the public value, so a step that is not published is not searchable.
- **Feeds exclude paths.** RSS, JSON Feed, `llms.txt`, `llms-full.txt` and the portfolio snapshot are
  byte-identical with or without paths. A path is an editorial route, not a dated item, and a feed
  reader would have to be told when it changed.
- **`paths.json`.** The listed paths of the public value, with the base path applied, written only when one
  is listed. It carries no author step ids and is the same bytes for the same input. The build's check refuses
  it if it names a path the manifest does not publish, a post the build does not publish or an atlas entry
  the atlas does not.
- **The publication manifest** gains a `reading-paths` projection (present only while the switch is on)
  with one `path` item per published path: label, address, the posts it names, the fields copied and
  whether it is listed.

## Consequences

- Turning paths on changes the pages of posts and atlas entries that a listed path names, by one section;
  that is the point and is tested to be the only difference.
- An author who wants a path reachable only by a shared link marks it `listed: false`.
- Search shows a path with an empty date. The search page shows it among the posts, ranked by the same
  score.
- What a path leaves out is still reported to the author at build time (ADR 0211), not in the manifest.
