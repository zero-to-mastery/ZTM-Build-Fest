# ADR 0254: Callouts, tables, task lists, embeds and pieces are edited with forms inside their block, and an unedited block is never rewritten

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#332](https://github.com/journey-to-code-org/open.blog/issues/332)
- Parent story: [#318](https://github.com/journey-to-code-org/open.blog/issues/318)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Contract: `web/admin/block-forms.js`, `POST /admin/api/pieces`

## Context

The Visual editor keeps blocks it cannot show as a labelled "protected" card that carries the block's exact
Markdown. Callouts, tables, task lists and embedded media sit in that state, so an author must switch to
Markdown to change a word. Posts must still be saved as Markdown, a post that is not edited must be saved
byte for byte, and the raw HTML and knowledge-check blocks must stay protected.

## Decision

- **The form lives inside the card.** A protected block whose Markdown the editor can read back exactly gets an
  **Edit** button beside "Edit in Markdown". It swaps the card's body for a form (a labelled group named
  "Edit callout", "Edit table", and so on), with **Apply** and **Cancel**. Escape cancels. The card keeps its
  type label (`aria-label="Callout block"`), so the type is announced on arrival and the form is a group with the
  same name. Keys typed in the form do not reach the writing surface around it.
- **Only what round-trips is editable.** A block gets a form only if the form would write exactly the bytes that
  are there now (a callout whose lines all start `> `, a table whose rows have the same number of cells and hold
  no code with a bar in it, a task list of flat `- [ ]` items, a line that is only a YouTube or CodePen address,
  a well-formed `piece` fence). Anything else, and every knowledge check, footnote and piece of raw HTML,
  stays a protected card with no form and is saved unchanged.
- **An unedited block is never rewritten.** Apply writes the card's Markdown only if it differs from what was
  there; Cancel and an unchanged Apply leave the draft and the "unsaved" state alone. The card still holds the
  original Markdown as it always has.
- **The forms write the Markdown used today.** A callout is `> [!KIND]` and `> ` lines; a table is a GitHub
  table (a bar in a cell is written `\|`; column alignment is kept); a task list is `- [ ]`/`- [x]` lines; an
  embed is the bare address on its own line, checked against the YouTube and CodePen patterns the engine
  embeds. No new syntax, no HTML.
- **Pieces are written by the engine.** The `piece` fence (ADR 0253) has a form built from the engine's schema
  (`meta.pieces`). The Admin sends the values to `POST /admin/api/pieces`, which validates them with the same
  rules as the build and returns the Markdown or the list of problems; the Admin never writes piece Markdown
  itself and cannot save a piece the build would refuse. Nothing is stored by the call. The route is behind
  the usual authentication and CSRF check.
- **Keyboard and phone.** Every control is a native input, select, checkbox or button with a visible label or
  an `aria-label` that names its row and column ("Row 2, column 3", "Remove item 2"); changes to a list or a
  table are announced in a polite status; touch targets are at least 44px; a table scrolls inside its card
  rather than widening the page.

## Considered options

- **Edit in place inside the rendered block.** Rejected for now: contenteditable tables and nested quotes make
  the saved bytes depend on browser behaviour, which breaks "byte stable".
- **A modal dialog for each block.** Rejected: a form beside the block it changes keeps the context and needs no
  extra focus trap; the Add something dialog (ADR 0255) is for new things.
- **Parse tables and callouts on the server.** Rejected: the Markdown shapes are simple and the Visual editor
  already reads Markdown blocks on the client; only the pieces need the engine's rules.

## Consequences

- #333 reuses `buildPieceForm` and the same endpoint for its dialog.
- Tables with alignment colons, escaped bars and uneven spacing are normalised only when the author applies an
  edit to that table.
