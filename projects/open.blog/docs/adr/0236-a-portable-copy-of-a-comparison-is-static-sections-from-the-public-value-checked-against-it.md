# ADR 0236: A portable copy of a comparison is static sections built from the public value and checked against it

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#220](https://github.com/journey-to-code-org/open.blog/issues/220)
- Parent story: [#200](https://github.com/journey-to-code-org/open.blog/issues/200)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0232](0232-a-comparison-page-is-static-html-from-the-projection-with-levels-as-sections-a-selector-only-enhances.md), [ADR 0234](0234-an-explanation-states-its-authors-prerequisite-modes-and-withdrawal-and-one-explanation-serves-every-mode.md), [ADR 0235](0235-reading-modes-narrow-explanations-that-name-them-and-standard-shows-all.md)

## Decision

- **One builder, three copies.** `comparison_portable::portable_comparison` returns an HTML fragment,
  Markdown and plain text of a published comparison, built from the same `PublishedComparison` the page
  reads (ADR 0232). It reads no stored file, so a draft, an unapproved, stale, revoked or withdrawn
  explanation, the approver's login, a withdrawal reason and any private source have no path in.
- **Levels are labelled supplemental sections.** The interpretations and their evidence come first; then
  "Explanations by level", one section per level in beginner, student, scholarly order. Each explanation
  keeps what it states: what it is about, prerequisite, authors, language, revision, translation link and
  the AI label with the author's approval statement. The level selector, the reading-mode filter and the
  stored choice are interaction, so they do not travel: every approved explanation is included whatever
  its `modes`, and an info diagnostic says so (`explanation-levels-static`).
- **Canonical navigation.** Every copy names the canonical page and links each level on it. A feed reader
  or a printout therefore shows the address without relying on a link being clickable.
- **No markup from authored text.** HTML escapes everything and keeps `lang` and `dir="auto"`. Markdown
  backslash-escapes markup, link and block syntax. Direction override and embedding controls are removed
  from every copy as defence in depth (the contract already refuses them in names). The HTML has no
  script, custom element, inline style, frame, form or image.
- **Integrity and portability diagnostics are one list.** `portable_comparison` checks its own output with
  `check_portable`, which an exporter can call on any copy it changed. Errors: `explanation-missing`,
  `explanation-provenance-lost`, `canonical-link-missing`, `scripted-markup`. Messages name ids and the
  format, never authored text. A copy with an error is not published.
- **Written beside the page.** A comparison with explanations gets `portable.html`, `portable.md` and
  `portable.txt` next to its `index.html` in the static build. A copy that is not sound stops the build.
  The output boundary lists these files with the page: each must name a comparison the manifest
  publishes. No feed gains items (comparisons are not feed items, ADR 0232) and Admin shows no export;
  those destinations are separate tasks. Nothing here ranks, scores or counts agreement.

## Consequences

- Cross-posts and feeds can carry every approved level with attribution, and a regression that drops a
  level, an AI label or the canonical link fails a test instead of reaching a reader.
