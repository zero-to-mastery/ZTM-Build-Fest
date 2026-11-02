# ADR 0235: Reading modes narrow explanations that name them, and standard shows all

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#219](https://github.com/journey-to-code-org/open.blog/issues/219)
- Parent story: [#200](https://github.com/journey-to-code-org/open.blog/issues/200)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0234](0234-an-explanation-states-its-authors-prerequisite-modes-and-withdrawal-and-one-explanation-serves-every-mode.md), [ADR 0232](0232-a-comparison-page-is-static-html-from-the-projection-with-levels-as-sections-a-selector-only-enhances.md), reading modes (ADR 0140 to 0144)

## Decision

- **Static output carries the data, not the choice.** Each explanation that names modes gets
  `data-modes="guided deep-dive"`; one with `language` gets `lang`. Translation pointers, the revision and the
  authors are visible text. Without JavaScript every explanation is on the page.
- **`<ob-explanation-levels>` only reads the reader's reading mode.** It uses the same per-site key as
  `<ob-reading-modes>` (and its `data-ob-base`), reads it and never writes it. No new storage, no network,
  no personalization: the mode is the reader's own local preference.
- **Standard filters nothing.** The reading-modes rule "standard shows no supplements" does not apply here,
  because on a comparison page the explanations are the page's content, not extras on an article. Standard
  is the complete page. The modes are cumulative as for every supplement (ADR 0140): deep dive shows what is
  offered in guided or in deep dive. In guided or deep-dive, an explanation that names modes none of which
  shows in the current one is hidden; one that names none is in every mode; a list the page cannot read hides nothing.
- **No broken controls.** A level with nothing left to show gets no button and no link in the level list.
  With fewer than two levels no switch is built. A short note says explanations were left out and
  carries a "Show all explanations" button, because the comparison page has no reading-mode control; it
  shows everything on this page only and never writes the saved mode. A link into a left-out explanation,
  or into a level the mode emptied, shows it. Print shows everything.
- **Evidence and prose are untouched.** Only `.ob-explanation` items and level sections are hidden; the
  interpretations, their quoted evidence and the article are never changed by a mode or a level.
- **Failure reads as standard.** A blocked store, an unknown value or a missing script shows everything.

## Consequences

- An author can offer a note only to readers in deep-dive without a second copy of the explanation.
- A mode change in another tab re-applies the filter on this page.
