# ADR 0060: Citation navigation is static HTML, and the build checks it against the reference data

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#65](https://github.com/journey-to-code-org/open.blog/issues/65)
- Parent story: [#25](https://github.com/journey-to-code-org/open.blog/issues/25)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md),
  [ADR 0059](0059-published-reference-data-for-citation-previews.md)
- Contract: [Citation format](../specs/citations.md)

## Context

A3 already writes each generated marker as a `doc-noteref` link named "Citation N" with its own
id, and ends each note with one `doc-backlink` per citing marker. ADR 0059 defined the reader
reference data but did not put it on the page. Before the preview component (#66), a reader with
no JavaScript, a keyboard or a screen reader must be able to follow a citation to its reference and
return to the same place, on screen and on paper.

## Decision

- **The data goes in the head, on opted-in post pages only.** The renderer writes
  `ReaderReferences::to_script_element()` in `<head>`, after the JSON-LD, the way page data is
  already injected. Pages of posts that publish no citations, indexes, feeds, search data,
  portable copies and `llms.txt` never carry it, so they are byte-for-byte what they were.
- **The notes are one named region.** The generated heading and notes, which always close the
  post, are wrapped in `<section class="ob-citation-notes" role="doc-endnotes"
  aria-labelledby="…">` naming the generated heading's own id (`notes`, or `notes-2` when the
  author already has a "Notes" heading). That one generated heading's id also steps aside from
  the ids the post writes itself (`{#id}` values, footnote labels such as `[^notes]`, raw HTML
  `id`s, in any case and quoting), so the region's label is the only element with that id. The
  author's own headings keep exactly the ids they have without citations, so turning citations on
  never moves an inbound link.
  The author's own footnotes stay outside it, unchanged.
- **Generated ids avoid the author's headings.** The generated label prefix (`cite-`, then
  `cite2-` and so on) also skips any prefix for which a heading id, written or slugged (`## Cite 1`
  is `cite-1`), would be a note id `<prefix><n>` or a marker id `<prefix><n>-ref-<k>`.
- **Following a marker moves focus to the note.** Each generated note has `tabindex="-1"`, so
  fragment navigation focuses it without JavaScript; the next Tab reaches its links and its way
  back. The existing markers and back links (and their localized names) are kept, not duplicated.
- **Arrival is visible and nothing is clipped.** `:target` outlines the note or marker reached,
  `scroll-margin-block` keeps it clear of the edge, and notes wrap long addresses anywhere, so
  high zoom never scrolls sideways. Colours come from theme tokens.
- **Print keeps every note.** Print hides only the back links, which have no meaning on paper, and
  keeps each note whole.
- **The build checks the page against the data.** `check_page` now requires exactly one element
  per marker and note id and per region label, the marker to link to its note, and a link back to
  the marker. It runs on
  the finished page in `generate` and the Admin preview; a mismatch (for example authored raw HTML
  that repeats a generated id) stops with a diagnostic naming the post, rather than publishing a
  citation that leads nowhere or to the wrong place.

## Consequences

- Every citation is followable with no script; the preview component (#66) only enhances it.
- A post whose own HTML reuses a generated id is refused, with a diagnostic naming the id, until
  the author renames that id; headings never cause it.
- Themes cannot change the region or note markup; they style it through the shared tokens.

## Domain language

**Citation endnotes** is defined in [`CONTEXT.md`](../../CONTEXT.md).
