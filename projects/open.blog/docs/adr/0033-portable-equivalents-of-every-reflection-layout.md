# ADR 0033: Every reflection layout has the same static portable equivalent

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#173](https://github.com/journey-to-code-org/open.blog/issues/173)
- Parent story: [#148](https://github.com/journey-to-code-org/open.blog/issues/148)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0004](0004-portable-projections-from-canonical-work.md) derives portable HTML, Markdown, text
and feed content from the canonical work. A published reflection's body is the arrangement markup
[`compose`](0031-sequential-and-side-by-side-presentation.md) writes (a `div`, round `div`s,
`section.ob-turn` with an `h2` author, optional `p` label and prompt) around each author's own
Markdown. Portable HTML kept that markup, which already reads in order without CSS. Portable
Markdown, however, shows raw HTML as literal source, so Markdown, text, JSON Feed `content_text`
and the llms output printed `<section class="ob-turn ...">` as words, and llms-full.txt (built from
the page's search text) dropped every round prompt, author name and label. Separately, that literal
view escapes only `<` and `>`, so Markdown typed into a label (`[x](javascript:alert(1))`) became a
live link there.

## Decision

- **One equivalent for all five layouts.** A layout only places turns on a wide screen. Every
  portable form states the same thing: each round prompt, then each turn under a heading with its
  author's name, its optional label and the author's own Markdown, in reading order. The portable
  Markdown and text of one reflection are therefore identical whichever layout it is published
  with, and a test holds them equal across all five.
- **Read the arrangement back, narrowly.** `arrangement::Arrangement::parse` is the exact inverse
  of `compose` over a Markdown body: a closed grammar of the lines `compose` writes, found through
  the Markdown parser's raw HTML events so a turn that shows `</section>` in a code block is body,
  not frame. It applies only to a post with shared attribution. Anything else (a stray tag, text
  between sections, an unknown layout or entity) is not recognised and keeps the existing portable
  handling, which fails closed. Turn bodies are never interpreted. This reads the authored Markdown
  that is the canonical source, not generated HTML, so ADR 0004 stands.
- **Portable Markdown and text** are built from that arrangement: the round prompt as a bold
  paragraph, `## Author`, an italic label, then the author's Markdown. Untrusted values (names,
  labels, prompts) go through the existing shared-text escaping, so none can become a link, image,
  tag or entity. Text is the Markdown rendered as plain text, as before.
- **llms-full.txt** prints the same arrangement text for a reflection instead of the page's search
  text, so prompts, names and labels stay beside their words. RSS and JSON Feed content use
  portable HTML, and JSON `content_text` the portable text, so they follow.
- **Semantic-loss reporting.** Portable HTML emits one Info diagnostic,
  `reflection-layout-sequenced`, for a layout other than sequential: the placement (columns,
  stagger) is the only thing a portable copy does not carry, and it says so rather than letting it
  disappear. Nothing is added to the visible text for this.
- **Checked, not assumed.** The portable semantic-fact check (which already refuses an export
  that lost credits or the source) now requires every round prompt, author name and turn label in
  every representation, and in the arrangement's order. A projection that dropped or reordered one
  fails with `missing-semantic-fact` or `reflection-order`; nothing is rewritten and the
  canonical content is unchanged.
- **Labels, prompts and names are written as character references.** Because the Markdown export
  shows the arrangement's raw HTML as literal Markdown, `compose` writes every ASCII character
  Markdown can act on (`[ ] ( ) * _ \` ! \ ~ # | & : @`) as a numeric character reference in those
  three values, besides escaping `< > "` and `'`. An HTML parser and a Markdown parser both decode
  them to the same visible text, so the page, portable HTML and the literal view agree and none
  can form a link. Existing published posts keep their older escaping; the reader above decodes
  both.
- **Private data.** Only the approved, published body and public attribution are involved. No
  structure file, draft, participant id, admin user, approval or revision reaches any form, and
  the privacy list in the conformance tests checks every output.

## Consequences

- Any destination or reader that cannot run CSS or JavaScript gets the whole reflection, in order,
  with every author named, in Markdown, text, both feeds and llms-full.txt.
- Pixel-equivalent external rendering stays out of scope: a destination that wants columns builds
  them from the labeled sections.
- The arrangement grammar and `compose` must change together; a test composes every shape and
  reads it back.
- The continuing conversation (ADR 0026) follows the arrangement after the section break the gate
  writes. `Arrangement::parse` accepts exactly that tail as ordinary Markdown (`trailing`), so a
  reflection with both an arrangement and approved synthesis exports as labeled sections and then
  the conversation. The reading-order check compares the reflection's own headings, labels and
  prompts, not the credits or metadata that repeat the same names.

## Reversibility

Additive and derived. No stored format changes; published Posts keep their markup and the
projections are recomputed on every build.
