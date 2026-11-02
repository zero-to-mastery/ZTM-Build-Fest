# ADR 0174: Contextual entry previews read the public query file and enhance an ordinary link

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#74](https://github.com/journey-to-code-org/open.blog/issues/74)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0061](0061-citation-previews-are-a-progressive-non-modal-component.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0171](0171-the-query-file-carries-the-pages-wording-and-a-works-source-and-its-lookup-is-one-shared-algorithm.md),
  [ADR 0172](0172-an-article-links-a-term-to-an-atlas-entry-only-where-the-author-writes-an-atlas-link-and-only-if-the-entry-is-published.md),
  [ADR 0173](0173-a-concept-link-is-only-a-link-where-it-can-be-one-and-every-other-place-shows-its-words.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#entry-previews)

## Context

A reader who meets a concept link (ADR 0172) should be able to see what the entry is, where that
comes from and how firmly the nearby relationships are held without leaving their place, and always
be able to go to the complete static entry page. The citation previews (ADR 0061) already settled
how such a card behaves for a keyboard, a pointer, a touch screen and a screen reader.

## Decision

- **The link stays the page.** Without JavaScript nothing is added: the link is the ordinary link to
  the entry's page. The component only enhances a link that still leads to the entry's own page
  (its path equals the `url` the query file gives for that id), so a hand-written link cannot be
  made to preview something else.
- **One public file, fetched at first interest.** The component reads `atlas-query.json` (ADR 0168), the public
  projection, from the site's own origin, and nothing else: not the page, not the private atlas, not
  another host. Inline per-post data was rejected: it would put copies of entry text, sources and
  relationships into every post page, which the publication boundary would then have to list and
  check per post, while the query file is already a listed, bounded, checked artifact. The cost is
  one request per page view in which a reader shows interest in a concept link (focus, hover or a
  press), and none otherwise: nothing is fetched on load or when the page is idle. A touch screen
  has no hover to show interest before the tap that must already find the file, so there only, and
  never for a reader who asked to save data, and only when the file is under 256 KiB (the element
  carries `data-bytes`, the written file's size; a larger or unknown size waits for the first
  tap), a concept link scrolling into view is the interest. A
  page without a concept link never loads the component. The build adds the element only when the
  file is actually written (ADR 0169 can leave it out), so a link never waits for a file that is not
  there. The page names the file with its content hash (`/atlas-query.json?v=<16 hex digits>`, the
  BLAKE2s hash of the written bytes), so a browser never reads a stale copy after the atlas changes
  and the same atlas always makes the same page; the hash and the file come from one projection
  made once per build.
- **Focus before the file.** If a link has focus when the file arrives, the preview opens and the
  link is described by it, and one polite status announcement (the entry's label, type and summary)
  is made, because a description added after focus is not read again by itself. A link whose
  preview cannot load stays a link and says nothing.
- **Failure is quiet and total.** A file that cannot be fetched, is not JSON, is not this format or
  a newer version, or lists no entry for a link leaves that link an ordinary link: no message, no
  half-preview. Each entry, relationship and source is validated on its own.
- **What a preview says.** The entry's type is its `kindLabel`; its provenance is the line "From the
  author's approved Knowledge Atlas" (every public entry is approved) and, for a work, its `source`.
  The summary is the file's `preview`, with "The entry's page has the rest." when it is clipped. Up
  to two relationships are listed from the file's own fields (`assertedByText`, `confidenceText`,
  `standingText`, `uncertainty`, evidence `text`, never reworded), in the direction they were stated
  and from the entry's own side; the rest are counted and the page lists them. Uncertainty and
  dissent are therefore shown with the claim, and the component says nothing about truth, consensus
  or authority. The words around the data are English defaults the page may replace with attributes.
- **Behaviour is the citation preview's.** Focus opens it and describes the link with it, Tab
  continues into its one link (it follows the link in the page), there is no focus trap, Escape
  closes it and returns focus without reopening it, hover opens and leaving closes it, the first tap
  opens it and a second follows the link (Enter and assistive technology always follow it; a tap
  before the file has loaded follows the link), pressing or focusing anything else closes it, the
  page never scrolls, placement stays inside the viewport (below the link, or above where only that
  fits) and the animation is only played when the reader has not asked for reduced motion.
- **A link in a heading keeps the heading's words.** The preview is placed after the heading, not
  inside it, so it is not part of the heading's name or the outline, and the link's hint is a
  description (ADR 0173), not hidden text in the heading.
- **No doubled hint.** The link already reads "label (atlas entry)" (ADR 0173). The preview is the
  link's description and starts with the type ("Person"), so a screen reader hears "Plato (atlas
  entry)", then "Person. From the author's approved Knowledge Atlas. ...".
- **Fields are not HTMLElement properties.** The component keeps its card as `card` and its links as
  `anchors`; a browser test reads every field each component assigns (simple, compound and update
  assignments) from the source and asks the real `HTMLElement.prototype` (`name in
  HTMLElement.prototype`), not a list kept by hand (`popover` broke the citation previews).
- **Base paths.** The element's `src` and the file's `url` fields are rewritten with every other
  address by the build; the component compares paths, so it works under any base path.
- **Only public fields, as text.** Every value is assigned as text. The one link is the link's own
  checked destination.

## Consequences

- A reader pays for the query file only after showing interest in a link; the bound (4 MiB,
  normally far smaller), `saveData` and the 256 KiB prefetch limit are the limits. On a touch screen a
  first tap before the file has arrived follows the link, as it did before previews; a large file
  therefore costs the first tap a plain link, and a small one is ready before it.
- A site whose build leaves the query file out has plain links and no component.
- The preview wording is English until the fixed wording of the site is localised.
