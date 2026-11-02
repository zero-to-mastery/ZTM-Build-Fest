# ADR 0241: Highlights and notes are opt-in per site, keep the article unchanged and save only to bounded local storage

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#85](https://github.com/journey-to-code-org/open.blog/issues/85)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0076, ADR 0077, ADR 0082, ADR 0237, ADR 0238, ADR 0240
- Serves: [#86](https://github.com/journey-to-code-org/open.blog/issues/86), [#87](https://github.com/journey-to-code-org/open.blog/issues/87)

## Context

The contract (ADRs 0237-0240) defines a reader's annotation document and nothing uses it. The first use
is selecting words in a post, keeping a highlight or a private note, and finding it again on a later
visit, possibly after the author has revised the post. The post must read the same for everyone, reading
must never need storage, and what a reader keeps must survive a failing or full browser store without
being lost or corrupted.

## Decision

- **A site opts in.** `readerAnnotations.enabled` (off by default, omitted from the written
  configuration while off) gives each post a region, "Your highlights and notes", with static text that
  says what it needs, the build's passage data (ADR 0076) and one script. A site that does not opt in is
  byte for byte what it was. The region holds only text: no annotation, note or reader identity is ever in a
  built file, and nothing is sent anywhere. When the feedback form is also on, the passage data and its
  element are published once and shared.
- **The article is never changed.** Saved passages are painted over the post with the CSS Custom
  Highlight API where the browser has it, in system colours so they stay legible in every theme and in
  forced-colours mode. Where it is missing, nothing is painted, and nothing else changes: every
  annotation is also a list item with named buttons (show in the post, add or edit a note, delete with a
  confirmation), so keyboard and screen-reader use never depends on the paint.
- **A selection becomes a passage target by the feedback form's own mapping.** The mapping moved to
  `passage-selection.js` and both components use it, so a quotation means the same thing in both. A
  selection that cannot be quoted (it crosses sections, or spans a note marker, code or embedded content) is
  explained, not guessed. A selection is kept as the last valid one, so moving focus to a button does not
  lose it; a note can instead be attached to a section (with its digest) or the whole post.
- **Staleness is derived on every visit** with `assessAnnotations` (ADR 0238). A highlight whose words
  are found again in changed text is shown as moved and painted at the new place; one that cannot be found, or
  is ambiguous, is shown as not found with the reason in plain words and stays in the list with its quoted
  words, never silently moved or deleted. It can still be edited and deleted.
- **Storage is one key, bounded, and never required.** The whole document is kept under
  `openblog.reader-annotations` in `localStorage`, validated by the contract's limits (4 MiB, 2,000
  annotations) on every read and write. Every access is guarded. If the browser denies storage, the
  reader is told and the changes stay in memory until the page closes. If it is full, the same, and what was
  saved is left as it was. If something unreadable or foreign is saved under the key, it is never
  overwritten: the reader is told, and new changes stay in memory. Each change is applied to the freshest
  saved document, so two tabs do not overwrite each other, and a change from another tab refreshes the list.
- **Reader text is only ever set as text.** Notes are shown with `textContent` in a pre-wrapped block;
  messages never repeat reader text except the reader's own selected words, shown as text.
- **Identity.** The work is `location.origin` plus `location.pathname`, which is already percent-encoded
  (ADR 0238); the revision is the passage revision the page published.

## Consequences

- #86 and #87 read and write the same key through `reader-annotations-store.js` and reuse its validated
  changes; import and export live beside it.
- A reader in a browser without the Custom Highlight API gets the list but no paint, by design.
- There is no Rust twin: reader data never reaches the build, Admin or a hosted function (ADR 0237).
