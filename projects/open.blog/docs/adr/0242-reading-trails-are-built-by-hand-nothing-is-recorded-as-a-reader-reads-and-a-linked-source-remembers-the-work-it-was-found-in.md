# ADR 0242: Reading trails are built by hand, nothing is recorded as a reader reads, and a linked source remembers the work it was found in

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#86](https://github.com/journey-to-code-org/open.blog/issues/86)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0237, ADR 0238, ADR 0240, ADR 0241
- Serves: [#87](https://github.com/journey-to-code-org/open.blog/issues/87)

## Context

The contract (ADRs 0237-0240) already holds saved sources and trails, and highlights and notes are kept
on a post (ADR 0241). A reader also needs somewhere to see what they have kept across posts, to save a
post or a reference it cites, to line things up as a trail, and to remove one thing or everything. The
story forbids tracking: no server learns what anyone reads, and a trail must be something the reader
chose to start.

## Decision

- **Collection is opt-in by construction.** There is no automatic history. A trail is a list the reader
  names and fills by hand; a source exists only because the reader pressed "Save". Visiting a page records
  nothing, and the panel says so in plain words, above the controls and in the no-JavaScript text. A site
  that has turned on `readerAnnotations.enabled` gets this panel with the highlights, with no further
  setting: it holds no data until the reader acts and sends none ever.
- **A separate element.** `<ob-reading-trail>` (`web/components/ob-reading-trail.js`) has its own region,
  "Your reading trails and saved sources", beside the highlights. `<ob-annotations>` keeps rendering only a
  page's own annotations. Both use `reader-annotations-store.js`, so every change is built from a copy and
  checked by the contract before it is kept, and the two refresh each other through a window event and the
  browser's `storage` event.
- **Saved sources keep their context.** A saved source is the post (a `work` source) or a reference the post
  cites, taken from the page's own reference data. A reference with an outside link is saved by that link
  and records, in a new optional `from` field, the work it was found in. A reference without one is saved as
  a link to its note in the post (a fragment of the post's address) with the same `from`. The reference's
  formatted text is the title, cleaned and cut to the contract's length. `from` is additive to version 1
  (nothing had been released), is only valid on a source with a `url` (a `work` source is its own origin),
  and is not reader text, so an export without notes keeps it. The same link or work is never saved twice.
- **Order and duplicates.** A trail keeps its steps in the order the reader built, once each (the
  contract's `duplicateStep`), up to 200, and there are up to 50 trails. Steps move one place at a time with
  buttons, so ordering never depends on dragging. Trails are listed most recently changed first; the posts
  the reader has marked are listed most recently marked first. Removing a step keeps the record it named.
  Deleting a source or an annotation removes its steps; deleting a trail keeps what it named.
- **Clearing is explicit and scoped.** Each removal (a source, a trail, one post's highlights and notes) asks
  first and changes only that. "Clear all my local data" removes the whole key, including data this
  version cannot read, because it is the one way a reader can recover from it; it says so first and is the
  only action that ever touches unreadable data.
- **This panel keeps nothing in memory only.** Unlike a highlight, which is also kept until the page is
  closed when storage fails, a source or trail that cannot be saved is refused with the reason (denied,
  full, unreadable) next to the control, and nothing, in the browser or on the page, changes. Unreadable
  saved data is never written over.
- **Text is only ever text.** Titles, trail names and notes are set as text. Every link comes from
  validated data (http or https, no credentials); outside links carry `rel="noopener noreferrer"`. The page
  and the reader's data are never joined: nothing the reader keeps is in a built file.

## Consequences

- #87 reads and writes the same key and may rely on `from`, `commitStore` and `clearStore`; its import must
  still never overwrite unreadable saved data.
- A reader who wants a trail that follows them across devices exports it (#87); there is no sync.
- Recently read pages are not shown, by design. A "recent trail items" view means the trails and steps the
  reader most recently changed.
