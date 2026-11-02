# ADR 0141: A reading mode only shows or hides supplements, and every representation stays complete without it

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#68](https://github.com/journey-to-code-org/open.blog/issues/68)
- Parent story: [#26](https://github.com/journey-to-code-org/open.blog/issues/26)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0140](0140-a-supplement-is-a-marked-block-quote-the-author-wrote-into-the-post.md),
  [ADR 0004](0004-portable-projections-from-canonical-work.md)
- Amended by: [ADR 0142](0142-supplements-keep-real-headings-a-visible-boundary-and-warnings-in-every-mode.md)
- Contract: [Reading modes](../specs/reading-modes.md)

## Context

Controls (#69), progressive rendering (#70) and safeguards (#71) need one agreed meaning of the three
modes and one static markup to enhance. The epic's invariant is that every capability has a native
accessible experience and a deterministic portable fallback, and that no authored content disappears
silently.

## Decision

- **Three modes, cumulative.** `standard` shows no supplement, `guided` shows `guided` ones, and
  `deep-dive` shows both. `ReadingMode::shows` is the one rule; the names are exactly
  `standard`, `guided`, `deep-dive`.
- **A mode is a visibility choice and nothing more.** It does not reorder, rewrite, summarise,
  personalise or remove anything, and it does not change the article's HTML, text, citations,
  footnotes, headings, links or ids. Nothing in the contract claims a supplement is true, agreed or
  permitted to copy, and a mode never ranks or filters by viewpoint.
- **The page is complete without JavaScript: every supplement is written out visible.** The build
  never writes `hidden`. A reader without script, a feed reader, a search engine and a printout all
  get every labelled supplement in document order. Standard mode being "uninterrupted" is therefore an
  enhancement applied by the control (#69/#70): it hides the supplements the chosen mode does not
  show, from the preference the reader keeps locally (or the author's default mode, ADR 0142), and
  shows all of them again if script is unavailable. A supplement that holds a warning or caution
  callout is never hidden by any mode. A reader's choice is a local presentation preference and
  is never sent anywhere.
- **The static markup** is one `div.ob-supplement` per supplement, with `id="ob-supplement-N"`,
  `role="group"`, `aria-labelledby` its label, `data-ob-supplement`, `data-ob-kind` (the kind word)
  and `data-ob-level` (the *effective* level, `guided` or `deep-dive`). Its first child is a label
  paragraph: the kind in `strong`, then "guided supplement" or "deep-dive supplement", then the title.
  Then the author's words in a real `blockquote`, then a closing paragraph
  `<p class="ob-supplement-end"><strong>End of definition supplement.</strong></p>`. The quote and
  the `strong` labels are structure that a feed reader and a page with no stylesheet both keep, so the
  boundary is visible without CSS (ADR 0142). It is a group, not a landmark, so many supplements do
  not flood a screen reader's landmark list. All text is escaped; the marker line is replaced by the
  label. A supplement that holds a warning or caution callout also has `data-ob-always`.
- **Portable copies.** Portable HTML, RSS and JSON Feed carry the same visible labelled groups;
  portable Markdown carries the quote with its marker line exactly as written; plain text (and the
  JSON Feed `content_text`) carries the words between a line naming the supplement and a line
  `End of ... supplement.`. All are fully portable: no link to the canonical article is needed to
  keep the meaning. The registered capability `guided-reading-supplements` is reported for a post
  with supplements, with its own fallback and level `fully-portable`. It is no longer a planned
  capability: the registry marks it `implementation_status: implemented` with an
  `implemented_fallback`, and the planned-capability tests skip the canonical-only label for it
  while still requiring the public prose to survive.
- **Semantic-loss checks** treat the supplement words as ordinary content: the marker line is not a
  fact a representation must carry, the words are.
- **Failure scope.** A malformed marker is a finding about that marker; the rest of the post and the
  other supplements are unaffected. Nothing writes a file, so no canonical file or browser data can
  be left changed.

## Consequences

- #69 can build the control from the three names and `ReadingMode::shows`; #70 hides by the
  `data-ob-level` attribute; #71 can check that the article text is identical whichever mode is on.
- The no-script page is longer than the standard reading. That is the price of never hiding
  authored words from a reader who cannot run script, and a post author controls it by how much they
  write in supplements.

## Domain language

**Reading mode** is defined in [`CONTEXT.md`](../../CONTEXT.md).
