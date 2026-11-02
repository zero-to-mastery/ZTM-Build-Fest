# ADR 0138: A conversation follows its author's section as static HTML with anchors, bounded, and enhanced only by script

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#224](https://github.com/journey-to-code-org/open.blog/issues/224)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0031](0031-sequential-and-side-by-side-presentation.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md),
  [ADR 0135](0135-until-sections-have-anchors-an-approved-reflection-about-an-authors-section-is-named-by-its-author-and-never-linked.md),
  [ADR 0137](0137-an-approved-author-response-is-published-under-its-reflection-in-the-one-public-file-and-shown-only-where-the-one-rule-says-so.md)

## Context

Readers need to follow a reflection and the author's answer without losing the reflection or needing
JavaScript, and the conversation must never obscure the article. A shared reflection's turns are laid
out in lanes (ADR 0031), so a conversation placed as a sibling of a turn would join the grid and move
the author's words.

## Decision

- **Each author's section gets its anchor** `ob-by-<contributor>-<nth>` (ADR 0126) as the `id` of its
  own `<section class="ob-turn">`, written into the rendered body by the build, wherever author
  responses are not `hidden` and the committed body and credits pair. A reflection about that
  section's current text now links to it ("About a section by MINA", linked); a stale one still says
  "since changed or removed" and links nowhere, since the text it was about is not there. If the
  rendered turns are not exactly the attributed sections, in order, nothing is anchored and nothing
  is moved.
- **The conversation is inside the turn it is about, after the author's words.** It is one
  `<aside>` labelled "Reader reflections on this section", so it never leaves its lane, never
  moves the author's text or any other section, and reads in order without CSS. Inside, each
  reflection is an `<article>` headed "Third Perspective from a reader" (or "from NAME, a reader"),
  and the author's response an `<article>` under it headed "Author's response from NAME" with
  "Written by the author of the section this answers", so who wrote what is text, never colour,
  position or script. Headings descend h2 (the turn), h3, h4, h5. Each carries its day and, while
  reports are open, the progressive abuse-report form whose static text names the author. Everything
  is escaped; reader and author text are plain text with paragraphs at blank lines.
- **Bounded, and shown once.** At most five reflections follow a section, oldest first by the day
  received; any more stay in the post's "Third Perspectives" list, with their answers, so a long
  thread never buries the article and every reflection is on the page exactly once. That list keeps
  its place (it is where the canonical link lands) and holds one link to each conversation ("N
  reflections about a section by MINA"). Nothing is ranked, scored or counted.
- **Progressive enhancement.** `<ob-conversation>` wraps the aside. Without script it is a block of
  static HTML. With script a conversation of more than three reflections is folded behind one native
  `<button>` that names what it shows and how many, reports `aria-expanded`, controls the list and
  keeps focus, and a link to anything inside it opens it and scrolls to it. Nothing is fetched,
  moved or animated. It never folds in print.
- **Reflow, focus and print.** Turns, articles and the conversation set `min-width: 0` and wrap long
  words, so nothing scrolls sideways at 320px or 400% zoom, in a side-by-side lane or not; a link
  target gets an outline (not colour alone) and every control has a visible focus style; print
  keeps every reflection whole and hides report forms and the folding button.
- **Legacy bytes.** Where `author-response` is `hidden` or `off`, or the post attributes nothing, the
  page is byte for byte what it was before answers existed (a test compares it with and without an
  `answer` in the file). A published reflection that is not about an attributed section renders as
  it did.

## Considered options

- **A sibling of the turn.** Rejected: it joins the lane grid and moves the author's words.
- **Always collapsing.** Rejected: static reading must show everything, and hiding by default would
  hide a published answer from anyone whose script fails.
- **A new list of conversations at the end of the post.** Rejected: it separates a reflection from
  the words it is about.

## Consequences

A post whose author sections are anchored carries one extra `id` on each turn; nothing else in the
prose changes.
