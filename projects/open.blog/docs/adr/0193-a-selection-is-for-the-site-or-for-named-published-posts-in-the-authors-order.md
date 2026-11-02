# ADR 0193: A selection is for the site or for named published posts, in the author's order

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#196](https://github.com/journey-to-code-org/open.blog/issues/196)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0186](0186-a-selection-records-the-revision-it-was-made-against-and-is-stale-when-that-or-anything-it-depends-on-changes.md)

## Context

Curation is done beside one post. A selection that readers of every post are given is a different
choice from one for a single post, and the author orders what a post's readers see. The file
format is unreleased, so it stays at version 1.

## Decision

- **`posts` and `positions` are optional fields of a selection.** `posts` is a list of 1 to 50
  post slugs; absent means the whole site. `positions` maps a post slug to a whole number, the
  selection's place among that post's items, lowest first; a post with no entry sorts the item
  after every positioned one, and ties break by selection id. A scoped selection may be placed
  only in posts it is for (at most 500 entries). The map is per post because one number shared
  by several posts would let ordering one post reorder another: a whole-site selection both
  posts are offered has its own place in each. The format is unreleased, so it was changed
  before v1 shipped rather than carrying a single `position` forward.
- **A v1 record without them means what it always meant.** It is for the whole site and
  unplaced. Such a file is read and written back byte for byte; the two fields are written
  only when set.
- **Only a published post is ever named.** The published item lists the posts that are both named
  and published by this build, so a draft's slug is never disclosed. A selection scoped to posts
  none of which is published is withheld as `post-not-published`. A scope is syntax-checked when
  it is saved but not matched to a post, so an author can choose before a post is saved.
- **Public order is (first post, that post's place, id).** `PublicCuration.items` puts whole-site
  items first, then each post's by its place in that post, then id; `for_post(post)` gives one
  post's order (its own items and the whole site's, by that post's place then id). The published
  item's `positions` names only published posts, so a draft's slug is not disclosed.
- **Ordering is one post's act.** `order_for_post(post, ids)` gives the listed selections places
  1..n for that post and no other. A selection this post has placed that is not listed (a
  withheld one) keeps its relative place after the listed ones, so places stay unique and
  consistent. Narrowing a selection's scope drops the places it no longer needs.
- **Scope is part of the revision** (ADR 0186), and changing it is refused while the selection is
  stale. A place is not part of the revision: ordering is presentation, so ordering one post can
  never make a selection stale for another. An ordering is all or nothing and refuses a stale,
  unknown or not-offered selection.
- **A draft previews as published.** While the post being edited is not published, Admin's
  preview and ordering add that one slug to the published set for the read, the way Admin's
  production preview renders a draft as published, and label the result "when this post is
  published". The build's rule is unchanged: a selection scoped to a post that is not published
  is withheld as `post-not-published`, and a draft's slug is never written to a public value.
