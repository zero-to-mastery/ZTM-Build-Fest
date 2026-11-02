# ADR 0142: Supplements keep real headings, a visible boundary and their warnings in every mode

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#68](https://github.com/journey-to-code-org/open.blog/issues/68)
- Parent story: [#26](https://github.com/journey-to-code-org/open.blog/issues/26)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Amends: [ADR 0140](0140-a-supplement-is-a-marked-block-quote-the-author-wrote-into-the-post.md),
  [ADR 0141](0141-a-reading-mode-only-shows-or-hides-supplements-and-every-representation-stays-complete.md)
- Contract: [Reading modes](../specs/reading-modes.md)

## Context

Review of the first definition of supplements (ADRs 0140, 0141) found a panic on a citation inside a
supplement, a recipe that read a supplement's lists as its own, no visible boundary around a
supplement without a stylesheet, findings nobody saw, and several smaller gaps. This records the
decisions that close them. The reader control (#69) is ADR 0143.

## Decision

- **The post's own words are built beside the page text, not cut out of it.** The renderer keeps a
  second string that gets every push and trim the page text gets, except the words of a supplement.
  Byte ranges into a string that is later trimmed are never recorded, so a citation marker removed
  from `“justice [@plato]”` cannot leave a range off a character boundary. Description, word count
  and reading time are read from that string.
- **A supplement is found before the block transforms and wrapped after them.** The quote stays a
  block quote through the recipe, code and citation passes, which see a container and leave its lists
  and headings alone, and the labelled group is put around it last. A recipe's ingredients and steps
  are only the post's top-level lists.
- **A supplement has a visible boundary that needs no stylesheet.** The group holds the label
  paragraph (kind in `strong`), the author's words in a real `blockquote`, and a closing paragraph
  `End of <kind> supplement.` in `strong`. That is the structure callouts already use for portable
  copies. The page text, plain text and JSON Feed `content_text` carry a line `Definition supplement
  (guided): Title.` before the words and `End of definition supplement.` after them. The base
  stylesheet styles the group now (a border, an inset, a muted end line).
- **Findings reach the author.** Each finding is added, with the post's path, to the warnings the
  build, `check` and Admin already show: `posts/p.md: reading modes: `[!supplement kind=...]`: message`.
  It names the start of the marker line and nothing else. A bad `readingModes` value is a warning
  too.
- **`guided-reading-supplements` is implemented, not planned.** It leaves the planned-capability
  list. The registry gains `implementation_status: implemented` and `implemented_fallback`, and the
  tests that check a planned capability for a canonical-only label check an implemented one for its
  own fallback and the public prose instead.
- **`ob-supplement-` is reserved.** A heading slug that would start with it is written
  `section-ob-supplement-...`, so it cannot collide with a supplement id. The change in the heading
  slugger is one prefix check and one skip.
- **A heading inside a supplement stays a heading.** It is a real `<hN>` with an id (the author's
  `{#id}`, else `ob-supplement-N-hK`), is not in `headings` or the table of contents, and takes no slug
  from the post's headings, so a later heading is numbered as it would be without the supplement. The
  ids that other readers of the Markdown compute (`heading_ids`, passage targets) do not know the
  post opted in, so a heading inside a supplement still takes a slug there; they are unaffected
  unless a supplement heading repeats a later heading's title.
- **A title over 120 characters, or a kind over 32, is a finding with its own message and the
  marker stays a quote.** The full title is never silently cut.
- **A level is reported as overridden only when it was written.** A marker that took its kind's
  default level inside a deeper supplement is not "written inside a deeper supplement".
- **An escaped marker is not a marker.** `\[!supplement ...]` reads as ordinary text: the parser
  makes the `[` of a real marker a text event of its own, and an escaped one part of the text after
  it. Nothing is reported.
- **The default-mode key.** `readingModes: true`, or `readingModes: {default: standard|guided|deep-dive}`
  (also `reading_modes`), read tolerantly: `true`/`yes`/`on` and any map opt in, a bare mode name
  opts in with that default, `false`/`no`/`off` opt out, and anything else is off with a warning. A
  map never switches the post off, and an unknown default is reported and read as standard. The
  front matter reader has no block maps, so the map is written inline. The mode the post opens in
  is the reader's saved choice, else this default, else the site's default, else standard. The site
  default is the optional key `readingModes.default` in `openblog.json` (a mode name, or the bare
  name), read tolerantly: anything unreadable is standard and never fails the configuration. It
  decides only where an opted-in post that wrote no default of its own opens, and never opts a post
  in. A post that writes a default, including an unreadable one (read as standard), keeps it.
- **Warnings are never hidden.** A `[!WARNING]` or `[!CAUTION]` callout inside a supplement (at any
  depth) makes that supplement, and the supplements holding it, `data-ob-always`: shown in every
  mode, labelled "shown in every mode", and reported as a finding so the author knows their standard
  page now carries it. Hiding safety text was the one outcome that cannot be undone by the reader, so
  the conservative choice is to show it and say so, over hoisting it out of a hidden container or
  leaving it to hide.
- **Navigating into a hidden supplement shows it.** A link to an id inside a hidden supplement (a
  heading, a citation back-link) shows that supplement and the ones holding it, moves focus to the
  target and announces it. A generated note cited only inside supplements carries
  `data-ob-supplement="ob-supplement-1 ob-supplement-3"` (the supplements citing it, in order) so a
  link to the note can show where it is cited from. A reference list never changes with the mode.

## Consequences

- A recipe, a table of contents and the post's description are the same whatever supplements a post
  carries.
- Authors see unread markers where they already look for warnings.
- A post with a warning in a supplement shows that supplement in standard mode; an author who wants it
  hidden writes the warning in the article.
