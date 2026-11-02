# ADR 0067: One moment frame for the preview, the page and every portable form

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#177](https://github.com/journey-to-code-org/open.blog/issues/177)
- Parent story: [#149](https://github.com/journey-to-code-org/open.blog/issues/149)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0004](0004-portable-projections-from-canonical-work.md),
  [ADR 0028](0028-the-conversation-in-portable-output.md),
  [ADR 0033](0033-portable-equivalents-of-every-reflection-layout.md),
  [ADR 0066](0066-approved-moments-publish-through-one-public-projection.md)

## Context

ADR 0066 puts approved moments in the Post. A quotation needs its language and an attribution that
is not part of the quoted words, which plain Markdown cannot express, so the Post carries a small HTML
frame, as an arranged reflection does (ADR 0033). Portable Markdown shows raw HTML as literal source,
the preview must show exactly what will be published, and the portable semantic check must refuse a
copy that drops what was approved.

## Decision

- **One frame, one renderer.** `published_moment::block_markdown` is the single producer of the
  Post's moments block: frame lines (`section`, `h2`, a `div` per moment with `h3`, "Noted by",
  `figure`/`blockquote`/`figcaption`, a link paragraph) around each observation's Markdown. The page,
  portable HTML and both feeds render it like any other body. The combined preview renders each
  visible moment with `moment_markdown`, the same frame, through the same production renderer, so the
  preview and the page share their markup; a test holds each preview rendering inside the page. Only
  the review aids under a quotation (rights statement, guidance, rights note, provenance, warnings)
  are the preview's own, and they are never published.
- **Read the frame back, narrowly.** `MomentsBlock::parse` is the exact inverse of `block_markdown` for
  a body that ends with it after a section break, found through the Markdown parser's raw HTML events
  so an observation that shows a frame line as code is body, not frame. Anything else (inline HTML, a
  stray or altered line, a wrong number, text after the block) is not recognised and keeps the
  existing portable handling, which fails closed. It applies only to a post with shared attribution.
  An arrangement is read from the body before the block, so arranged reflections keep ADR 0033.
- **Portable Markdown and text** state the same facts without HTML: `## Moments in the sources
  {#moments-in-the-sources}`, then per moment `### <location> {#moments-in-the-sources-<n>}`, "Noted by
  <name>", the quotation as a block quote with hard breaks, "— <attribution>", the link as
  `[label](href)` (the timestamped link where the provider supports one, the original otherwise, and
  nothing when there is no link, the location being in the heading), then the observation. Every
  one-line value is escaped so it stays text, including a line-start list or heading marker. Text is
  that Markdown as plain text, so a link reads "label (address)". `llms-full.txt` prints the same text
  for a reflection with moments. The quotation's language has no Markdown form; portable HTML and the
  feeds keep it.
- **Checked, not assumed.** The portable semantic-fact check requires, for every published moment and
  in every representation, its location, "Noted by" with the author, the quotation, its attribution
  and its link with its label, and requires the moments in their approved order. A copy that drops one
  fails with `missing-semantic-fact`, one that reorders them with `moment-order`; nothing is rewritten.
- **No loss to report.** Portable HTML keeps the whole frame, and the frame is open.blog's own markup,
  so it is not counted as authored raw HTML and plain moments produce no diagnostic.

## Consequences

- The frame and its reader must change together; unit tests write every shape (with and without a
  quotation, link or observation, and hostile values) and read it back.
- Destinations that cannot run CSS or JavaScript get every moment, credited and linked, in HTML,
  Markdown, text, both feeds and `llms-full.txt`.

## Reversibility

Derived output only: no stored format changes. Published Posts keep their frame, and the projections
are recomputed on every build.

## Domain language

**Moment frame** is defined in [`CONTEXT.md`](../../CONTEXT.md).
