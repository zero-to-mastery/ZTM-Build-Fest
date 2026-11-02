# ADR 0076: Passage targets are section anchors with quoted context, over one published passage text

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#80](https://github.com/journey-to-code-org/open.blog/issues/80)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0059](0059-published-reference-data-for-citation-previews.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md)
- Serves: [#81](https://github.com/journey-to-code-org/open.blog/issues/81),
  [#82](https://github.com/journey-to-code-org/open.blog/issues/82),
  [#83](https://github.com/journey-to-code-org/open.blog/issues/83),
  [#84](https://github.com/journey-to-code-org/open.blog/issues/84),
  [#208](https://github.com/journey-to-code-org/open.blog/issues/208),
  [#210](https://github.com/journey-to-code-org/open.blog/issues/210),
  [#212](https://github.com/journey-to-code-org/open.blog/issues/212)

## Context

Readers will attach questions, sources, corrections (#81–#83, RD6), Third Perspectives (RD10),
responses to one author's section (RD11) and private annotations (#84) to places in a published
post. Posts change after publication. ADR 0059 rules out the obvious ids: citation marker and
note ids are positional and must not be stored. Heading ids are the only anchors the author
controls (`markdown.rs` gives each heading its `{#id}` or a slug of its title). A target must
survive edits gracefully, never silently point at other text, and work on the canonical page
without JavaScript, with the hosted service optional.

## Decision

- **One passage text, read from the publication.** A post's *passage text* is read from its
  publication Markdown (ADR 0048) with the renderer's own parser options and heading ids
  (`PassageDocument::of_post`), split into sections: the text before the first heading (no
  anchor), then each heading's id with its title and the text up to the next heading of any
  level. It is what the native page shows without what the page generates around it: footnote
  and citation markers, image alternative text, raw HTML, code blocks and the generated
  citation notes region are left out; an author's own footnote text stays where it is written.
  With embeds on, a paragraph that is only an embeddable link is left out too, as the page
  replaces it with a frame. Table cells are text; a raw HTML block, an embed frame and its
  caption are not (a test compares the build text with the rendered page for each). Text that
  only raw HTML or an embed shows cannot be targeted; a target made from it is reported stale,
  never matched elsewhere.
- **The build publishes the passage text; the browser never re-derives it from the DOM.** When
  feedback features are enabled (the opt-in of #82), the build publishes, as page data, each
  section's passage text, index, anchor and digest, plus the post's passage revision.
  `revision` and section `digest` are therefore *inputs* to the browser module, computed by
  the build; `web/components/passage-target.js` never computes either. To make a target the
  browser maps a reader's selection onto that published text: it normalizes the selected string
  as the build does and searches for it within that section's build text. Parity with the DOM
  is not required and not attempted, so generated parts of a page (anchor links, markers,
  labels, callout titles, controls, embed captions) never need to be filtered out in the
  browser. #82 and #84 consume this data.
- **Only whitespace is normalized.** Each run of Unicode `White_Space` becomes one space and the
  ends are trimmed. Case and Unicode normalization forms are kept exactly: a quotation copied from
  the page matches the page and nothing else.
- **Offsets count Unicode scalar values** (`Array.from` in the browser), never bytes or UTF-16
  units.
- **Character boundaries without Unicode tables.** A target may not begin or end in front of a
  continuing character (combining marks of the common scripts, ZWJ and ZWNJ, variation
  selectors, emoji modifiers, tags) or right after a ZWJ. This is a fixed approximation of UAX #29
  grapheme clusters, chosen so the build and every browser agree exactly instead of depending on
  each engine's ICU version. A boundary it misses can only make a target refused or stale.
- **Revisions and digests.** The *passage revision* is `p<model>:` plus 32 hex digits of a
  BLAKE2s fingerprint of every anchor and section text. The model number (`p1`) changes whenever
  this text model changes, so a revision of an older model never equals a current one. A
  *section digest* is 32 hex digits of the fingerprint of one section's text.
- **Two kinds of target, one flat versioned JSON object.**
  - Quote: `{"version":1,"kind":"quote","section":"methods","exact":"…","prefix":"…","suffix":"…","start":12}`.
    `exact` is the quotation (1–500 characters); `prefix` and `suffix` are up to 64 characters
    of the same section right before and after it, empty only at the section's edge, never
    crossing into another section; `start` is where `exact` began in its section at the revision
    the reader saw, a hint trusted only at that revision. This is the W3C Web Annotation
    TextQuoteSelector plus a position hint, scoped by the section anchor.
  - Section: `{"version":1,"kind":"section","section":"methods","digest":"…"}` for the whole
    section. The digest is optional so a reader without JavaScript can name a section from its
    link alone; without it the target can only be confirmed at the revision the reader saw.
  - Work: `{"version":1,"kind":"work"}` for the whole post, with no section and no selector.
    It resolves current while the post exists, at any revision, so a reflection on a whole post
    (RD10, RD11) has valid provenance. A section, digest or quotation field on it is refused.
  - `section` absent or `null` means the text before the first heading.
- **Sections are named by index.** Anchors are not unique: an author's `{#id}` can repeat a
  generated slug (`## Intro` then `## Other {#intro}`). A resolved location therefore carries
  the section's document index as well as its anchor, and the text at a location is read by
  index (and refused if the anchor disagrees). Public provenance publishes the `exact` text
  resolution verified, never text re-read by anchor.
- **Bounds and character rules.** Anchors are 1–200 characters without whitespace; text fields
  must already be passage text (single spaces, `exact` trimmed); control characters and the
  bidirectional embeddings, overrides and isolates are refused (they can make a quotation display
  differently from what it says); a quotation or its context may not start or end inside a
  character; `start` is at most 1,000,000; serialized targets are at most 16 KiB. Unknown fields,
  a missing or non-integer version and a newer version are refused with a code. Nothing is
  repaired. Error messages name the field and never repeat the text.
- **Escaping.** Quoted text is data. `context_html` writes `prefix<mark>exact</mark>suffix`
  with every character escaped; JSON is written by a serializer. The page's own text is never
  replaced by a target.
- **One contract, two implementations, one set of fixtures.** `openblog_core::passage_target`
  serves the build, Admin and moderation; `web/components/passage-target.js` (dependency-free,
  pure functions) serves forms (#82), local annotations (#84) and can validate in the hosted
  function (#81). Both read `tests/fixtures/passage-targets.json` and must produce the same
  targets, codes and resolutions. Integers are read as the build reads them: `version` and
  `start` must be canonical integer text (no `1.0`, `7e0` or `-0`), checked on the raw JSON
  token in the browser; a number that fits 64 bits but is newer or beyond bounds gets the
  build's code (`unsupportedVersion`, `invalidRange`), and one beyond 64 bits is `malformed`.
- **No page change yet.** Section anchors already exist on every page and work without
  JavaScript. Emitting the revision and digests for no-JavaScript forms and the mail or copy
  fallback belongs to #82, behind its opt-in, so existing pages are unchanged.

## Consequences

- A durable reference to published text is a section anchor plus a quotation or a digest, never
  a positional id. Renaming a heading changes its anchor; a quote target then still re-anchors
  by its text, and a section target by its digest (ADR 0077).
- A browser adapter does not read the DOM for passage text. It uses the text the build
  published, so a page may show more than the passage text (embed captions, raw HTML) without
  any parity risk; text outside it simply cannot be selected into a target. Pages that publish
  this data are a #82 change behind its opt-in; #82 and #84 consume it.
- Revisions change when any passage text changes, including through smart punctuation or a
  citation style that writes locators into the prose.

## Domain language

**Passage text**, **Passage revision**, **Passage target** and **Section digest** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
