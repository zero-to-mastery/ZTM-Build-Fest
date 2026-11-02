# ADR 0239: An export states its privacy scope and leaves note text out unless the reader includes it

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#84](https://github.com/journey-to-code-org/open.blog/issues/84)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0237, ADR 0238
- Serves: [#87](https://github.com/journey-to-code-org/open.blog/issues/87)

## Context

A reader should be able to take their reading trail elsewhere, but a file is easy to forward. Data stays
local unless the reader explicitly exports it, and what the file contains should be visible from the
file itself, not from the reader's memory of a checkbox.

## Decision

- **Every document carries `privacy`: `{ "scope": "reader-private", "notes": "included" | "omitted" }`.**
  The scope is fixed: even an export is the reader's private data and always holds the text of the
  highlights, which is quoted published text with the reader's interest attached. `notes` says whether
  the reader's own words (note text, a saved source's note, a trail's note) are in the file.
- **Notes are left out by default.** `exportDocument(document)` omits all of them and sets `notes` to
  `omitted`; `exportDocument(document, { notes: true })` keeps them and says `included`. A document that
  says `omitted` yet holds note text is refused (`privacyMismatch`), so the statement cannot lie.
- **A note on a quote keeps its highlight.** Without its text, a note on a quotation becomes a
  highlight of that quotation. A note on a section or the whole work has nothing left, so it is dropped
  and reported in `omittedNotes`; trail steps naming a dropped record are removed.
- **An export is itself a valid document** and round trips through `serializeDocument` unchanged:
  canonical field order, two-space indent, LF, trailing newline. Import validates as any read does
  (ADR 0240) and nothing is written on failure.
- **No third party.** Export and import are file or clipboard actions in the browser; nothing is
  uploaded.

## Consequences

- #87 owns the controls: the default is the safe one and the choice is visible before the file is made.
- Nothing about this makes an export publishable; the scope string says so to whoever opens it.
