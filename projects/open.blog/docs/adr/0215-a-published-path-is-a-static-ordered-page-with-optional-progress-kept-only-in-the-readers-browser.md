# ADR 0215: A published path is a static ordered page with optional progress kept only in the reader's browser

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#78](https://github.com/journey-to-code-org/open.blog/issues/78)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0210](0210-a-transition-is-the-authors-own-words-with-a-closed-relationship-that-never-defaults-to-influence.md),
  [ADR 0211](0211-a-path-names-only-published-items-and-a-missing-step-is-left-out-and-reported-to-the-author-only.md),
  [ADR 0212](0212-the-public-paths-value-is-an-allowlisted-deterministic-projection-and-nothing-reads-a-path-yet.md)
- Contract: [Reading paths](../specs/reading-paths.md#pages-and-progress)

## Context

ADR 0212 defined the public paths value and left it unread. This is the first reader: pages a
person follows, with an optional way to remember where they got to. Paths must read fully without
JavaScript, a transition must never say more than the author wrote, and nothing about a reader may
leave their browser.

## Decision

- **One page per published path, rendered from the public value alone.** `/paths/<slug>/` is
  semantic HTML: a heading, the author's summary, and an ordered list with one item per shown step.
  Each item has the step's number, a link to its post or atlas entry, its kind, the author's
  difficulty and `optional` marks, the transition, the rationale and the prerequisites note, and
  previous and next links to the steps around it. The page is complete without JavaScript and
  without the stylesheet. It reads the `PublicPaths` projection and nothing else, so a draft, a
  withdrawn step or an author id cannot reach it.
- **A transition says what the author wrote.** It shows the relationship's fixed label, the
  author's reason and which step it is about, by position and title, whenever that is not the step
  just above (an optional step between). `next` reads as "Comes next, with no further relationship
  claimed". A fixed note on every path page says that order alone never means one thing influenced
  another. Nothing is inferred from adjacency.
- **The switch and discovery.** Pages exist only while `readingPaths.publish` is on; off, the folder
  is never read and the site builds byte for byte as before. `/paths/` lists only paths that are
  `listed`; an unlisted path has its page but is in neither the index nor the sitemap, and an index
  is written only if some path is listed. Feeds, search and `paths.json` are decided in ADR 0216.
- **Progress is optional, local and resettable.** `<ob-reading-path>` adds a labelled checkbox per
  step, a status line, a link to the first required step not yet read and a reset button. Progress is
  a list of step targets (`post:slug`, `atlas:id`) in the browser's `localStorage`, one key per path
  (`openblog:reading-path:<slug>`); keying by target survives reordering and editing, and an entry
  for a step the path no longer has is ignored. Optional steps never count toward finishing. Nothing
  is sent, no account exists, and the progress never changes what the page says. Reset clears the
  key and moves focus to the status line, because the button it was pressed on disappears.
- **Failure leaves things as they were.** Refused storage: the component says progress cannot be
  saved, adds no controls and the path reads the same. Unreadable or wrongly shaped stored data is
  ignored and not overwritten until the reader changes something. A write that fails is said in the
  status line and the page keeps its in-memory state. The `storage` event keeps two tabs in step.
- **Problems are for the author.** An unparseable path file, a left-out step and a withheld path are
  warnings in the build output (the path and step, never a value or a target's title) and never in
  the page. A damaged file leaves the other paths and every other page unchanged.
- **A path file is never named like a Windows device.** `con`, `prn`, `aux`, `nul`, `com1` to `com9`
  and `lpt1` to `lpt9` are refused as path slugs (step ids keep the plain rule), so a path can always
  be created and read on every platform.

## Consequences

- Reading paths now render, so `/paths/` is reserved while the switch is on (already enforced by
  ADR 0212's check); turning it off removes the pages on the next build.
- Progress cannot sync across devices or be seen by the author. That is deliberate: it needs an
  account, which is out of scope.
- The component ships with every site, like the other components; only a path page loads it.
