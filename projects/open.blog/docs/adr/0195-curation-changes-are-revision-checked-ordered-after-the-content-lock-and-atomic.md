# ADR 0195: Curation changes are revision-checked, ordered after the content lock and atomic

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#196](https://github.com/journey-to-code-org/open.blog/issues/196)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0186](0186-a-selection-records-the-revision-it-was-made-against-and-is-stale-when-that-or-anything-it-depends-on-changes.md), [ADR 0089](0089-alignments-take-their-lock-after-claims-and-guard-what-they-use.md)

## Context

Authors select, select again, withdraw, scope, order and unselect research context while they
write. These are writes to a private research file from a UI, so they follow the rules every
research store already follows: authorization, a revision against lost updates, one lock order and
a write that cannot half-happen.

## Decision

- **Routes.** `GET research/curation[?post=slug]` reads the author's view; `POST`, `PUT` and
  `DELETE research/curation/selections` select, change (`reselect`, `withdraw`, `scope`) and
  unselect; `PUT research/curation/order` orders a post's selections. They sit behind the
  session, the CSRF token for every change and the deny-by-default router, so any other method or
  path under the prefix is a `404`. A body is JSON of at most 64 KiB; a selection with an unknown
  field is refused.
- **Stale-write protection.** Every change names the SHA-256 revision of the selections file it
  was based on. A different current revision is a `409` carrying the latest revision that changes
  nothing, and the page reloads. A damaged file is a `422` that names the file and is never
  replaced.
- **Lock order.** A change takes the content lock first (the build mutex and the content
  transaction), loads the saved site as a build does, then the atlas, alignments, notebook,
  library and selections locks in that order (ADR 0185), reads the stores and resolves
  against them under those locks, and writes. While nothing is stored the change is first tried
  without the locks, so a refused change creates no directory. A lock another writer holds is a
  `500` that changes nothing, after the usual wait. The locks cover the change only: they are
  dropped before the view is computed, so the projections never run while a store is locked. Every
  id in an ordering is checked against the id syntax before any is looked up or named, so a
  hostile id is never echoed.
- **Atomic with rollback.** The file is written to a temporary file beside it, flushed, and
  renamed over it; a failed write removes the temporary file and leaves the stored file byte for
  byte. Orderings are all or nothing. No route writes the research a selection points at, and
  none approves anything.
- **These routes only edit private choices.** The text an author writes for a comment is guarded like
  every private store until the build publishes it. While the site publishes curated context, a
  successful change rebuilds the served site, as an atlas change does, and returns the outcome as
  `build` (ADR 0201); a site that does not publish it is not rebuilt.
- **A run of orderings rebuilds once.** An ordering may say `"rebuild": false`: it is written, the
  served site is marked as behind (`build: { ok: true, pending: true }`, also on the next view), and one
  `POST research/curation/rebuild` after the last step rebuilds it and returns the outcome. The Admin
  waits for a short pause after the last move, then asks for that rebuild, so dragging an item through
  ten places builds the site once. Only an ordering can be deferred; every other change rebuilds at
  once. Whichever rebuild runs, its outcome, including a failure, is in the Admin's status line, and a
  failed rebuild never undoes a saved change. A change answers with the view computed from the one read
  of the research stores it was resolved against.
- **Stale places never refuse an ordering.** Giving a selection a place among a post's items can take it
  over the bound on how many posts it orders. When that happens the places for posts that are no longer
  published are dropped first; a selection that really orders that many published posts is still refused.
