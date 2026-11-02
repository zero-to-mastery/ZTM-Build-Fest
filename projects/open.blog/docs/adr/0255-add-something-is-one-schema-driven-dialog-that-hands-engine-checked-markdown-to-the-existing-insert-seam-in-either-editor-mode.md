# ADR 0255: Add something is one schema-driven dialog that hands engine-checked Markdown to the existing insert seam, in either editor mode

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#333](https://github.com/journey-to-code-org/open.blog/issues/333)
- Parent story: [#318](https://github.com/journey-to-code-org/open.blog/issues/318)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Contract: `openPieceDialog` and `buildPieceForm` in `web/admin/block-forms.js`

## Context

Authors should add a button, map, video or call-out to a post the way the landing page does, from a form,
without learning the `piece` fence (ADR 0253) and without any way to type HTML. The post editor already has one
seam that puts a block at the caret in either mode with undo and a spoken status (the research panel's
`insertFromResearch`, shared with citations). The landing page workspace (LB2) is built in parallel and needs the
same forms.

## Decision

- **One dialog, one schema.** **Add something** is a button in the Write toolbar, so it is available in Visual and
  Markdown mode alike. It opens a modal dialog titled "Add something" that lists the pieces from `meta.pieces`
  (label and a plain sentence each) as full-width buttons at least 56px tall, then a form for the chosen piece,
  built by `buildPieceForm` from the same schema entry. Lists (opening times, links, questions) can grow and
  shrink with Add and Remove buttons that announce the change and keep focus on a sensible control.
- **The engine decides, the editor inserts.** **Insert** sends the values to `POST /admin/api/pieces` (ADR 0254).
  A refusal is shown as a list inside the form, keeps every value, and inserts nothing. Accepted Markdown goes to
  the existing insert seam, which already refuses a caret inside code or HTML, writes after the caret's
  paragraph in either mode, restores an exact undo, and says what it did. A refusal from that seam is shown in
  the same place. In Visual mode the new fence appears as an editable Piece block (ADR 0254); in Markdown mode it
  is written at the caret, and the caret then rests on the blank line below so a second piece can follow.
- **Focus.** On open, focus goes to the first piece; on a form, to its first field; the dialog is labelled by its
  title, Escape and Cancel close it and put focus back in the editor with the caret and selection it had, and a
  successful insert leaves focus in the editor. This matches the Cite dialog. Keys typed in the dialog never reach
  the editor behind it.
- **Phone and keyboard.** The dialog is at most `calc(100vw - 2rem)` wide and `100dvh - 2rem` tall and scrolls
  inside itself, so the on-screen keyboard does not hide the Insert button; fields are at least 44px tall and use
  the right input mode (`url`, `email`, `tel`, `decimal`).
- **For the landing page workspace (LB2).** `buildPieceForm(schemaEntry, initialValues)` returns
  `{ element, values(), showProblems(list), clearProblems(), focus() }` and is independent of the post editor;
  `openPieceDialog({ pieces, build, onInsert, onClose })` takes its own `build` and `onInsert`. A landing
  workspace can show the same forms for its section types (`schema.section` names the landing type) and turn
  accepted values into a section with `Piece::section_kind` on the server, or save the values as section data.

## Considered options

- **A menu of plain Markdown snippets.** Rejected: snippets cannot be validated and leave the author editing
  `field: value` text.
- **Insert pieces without a round trip.** Rejected: duplicating the validators in JavaScript lets the editor
  save what the build refuses.
- **A non-modal sheet.** Rejected: neighbouring dialogs are modal, and a modal gives a clear focus return.

## Consequences

- A new piece is a schema entry and a renderer; the dialog and the Edit form pick it up from `meta.pieces`.
