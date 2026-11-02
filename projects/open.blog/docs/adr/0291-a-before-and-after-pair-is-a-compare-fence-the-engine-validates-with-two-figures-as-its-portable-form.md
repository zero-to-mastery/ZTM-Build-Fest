# ADR 0291: A before and after pair is a `compare` fence the engine validates, with two figures as its portable form

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#478](https://github.com/journey-to-code-org/open.blog/issues/478)
- Tasks: [#496](https://github.com/journey-to-code-org/open.blog/issues/496), [#497](https://github.com/journey-to-code-org/open.blog/issues/497), [#498](https://github.com/journey-to-code-org/open.blog/issues/498)
- Builds on: [ADR 0253](0253-pieces-are-validated-data-with-one-form-schema-and-embeds-are-privacy-enhanced-lazy-frames-that-degrade-to-a-link.md), [ADR 0059](0059-interactive-demos-have-authored-fallbacks.md)

## Context

Before and after photos are the best evidence a trade, a restorer or a gardener has. Today a theme has to fake
the pairing with raw HTML, and every feed, syndicated copy and export loses it. Any post, not only a job, may
want one.

## Decision

- **A `compare` fence, for every content profile.** The body is `key: value` lines: `before`, `before-alt`,
  `before-caption`, `before-label` and the same four for `after`. The picture and its alt text are required;
  caption is optional; labels default to "Before" and "After". An unknown key, a duplicate key, a missing
  picture or alt text, an address that is not `https` or a file on the site, and an over-long value are each
  a plain sentence naming the field. All problems are reported at once, in place
  (`ob-compare-error`) and in the build's errors.
- **The format is version-free and closed.** There is no version key: the field names above are the format,
  and a field a newer engine adds is an error here rather than silently ignored, so a post never means two
  things. Anything else that reads the Markdown shows an ordinary code block with every address and alt text.
- **Core owns it once.** `openblog_core::compare` parses, validates and renders; the page, the portable HTML,
  the portable Markdown and the accessibility audit all call it. It reuses the landing page's address check
  and length limits rather than defining new ones.
- **One capability, `before-after`.** It is reported on every page that uses the fence, with native renderer
  `ob-compare` (the "capability flag for themes") and fallback `figure-pair`. It is **fully portable**: both
  pictures and both captions survive, and the slider is only presentation, so an export raises no warning.
- **The page** is `<ob-compare class="ob-compare">` around two `<figure class="ob-compare-pane">` elements,
  each an `<img src alt>` and a `<figcaption>` that starts with its label. With no JavaScript, or when the
  reader prefers reduced motion, they are simply side by side.
- **The portable form** is those two figures and nothing else: no wrapper, no span, no script. Site paths are
  made absolute, the pictures are listed with the export's images, and a picture that cannot be made absolute
  is an error rather than a broken link. Portable Markdown is `![alt](url)` then the caption in italics, twice.
- **Images use the existing path.** The `<img src=` form is exact, so the build's lazy-loading pass and the
  portable address rewrite reach both pictures with no second pipeline. Uploads still go through Admin's
  `upload` route.
- **Accessibility.** Alt text is required by the fence, and the audit flags a filename or a stock word as the
  description the way it does for an image.

## Considered options

- **Two Markdown images in a container.** Rejected: nothing says which is which, alt text stays optional, and
  a feed reader cannot tell a pair from two pictures.
- **A `piece` kind.** Rejected: a piece is a landing-page section too, and a pair has no landing form.
- **Making the slider the only form.** Rejected: feeds, export and no-JavaScript readers need both pictures.

## Consequences

- A site that never writes a `compare` fence builds byte for byte as before; the fence is only matched when
  its info string is exactly `compare`.
- Adding a field later is a decision for a new ADR, since the format is closed.
