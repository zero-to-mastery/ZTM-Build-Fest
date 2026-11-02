# ADR 0047: Insert citations through a server-checked picker and keep them as atomic chips

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#41](https://github.com/journey-to-code-org/open.blog/issues/41)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0043](0043-opt-in-citation-markdown-syntax.md),
  [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0045](0045-citation-locators-reuse-notebook-locators.md),
  [ADR 0035](0035-private-notebook-storage-and-admin-capture.md)
- Contract: [Citation format](../specs/citations.md)

## Context

Authors need to insert and edit citations in both writing modes without learning the syntax.
The Markdown file stays canonical, the visual editor rewrites the whole document from its DOM on
any edit, and the visual editor escapes brackets in plain text. A citation that went through the
visual editor as text would come back as `\[@key\]`, which is no longer a citation. Hand-written
citations, including ones the picker cannot read, must survive untouched.

## Decision

- **Picker.** A modal **Cite** dialog in the Write toolbar searches the source library
  (titles, creators, identifiers, keys; Unicode-aware), lists live sources (an archived source
  only when the citation being edited already uses it), and takes optional locators in the
  capture form's `kind: value to end` lines. It can start from a live notebook passage, which
  copies the passage's source and its locators' kind, value and end only; the quotation, notes
  and extra locator fields are never copied. Cancel and Escape restore focus and the selection;
  nothing changes until Insert.
- **Server check.** Insert sends `{ revision, citation: { key, locators } }` to
  `POST /admin/api/citations/check`, which reads only `kind`, `value` and `to`, then runs
  `citations::check_citation`: format the Markdown, scan it back, resolve it against the library.
  The response's `markdown` is the only text the editor inserts. A library revision other than
  the one the picker loaded is a `409` with the latest sources, so the author's choices survive
  and nothing is inserted; a problem is a `422` scoped to that citation. The route writes nothing.
- **Visual mode.** Any `[@...]` the editor sees as a citation (not escaped, not a link, not in
  code) renders as an atomic, keyboard-reachable chip (`contenteditable="false"`,
  `role="button"`, `tabindex="0"`) that serializes back to its exact Markdown. A pasted chip is
  written back verbatim only when its text is a well-formed citation; anything else becomes
  escaped text. Click, Enter or Space on a chip reopens it in the dialog.
- **Typed and pasted citations.** Text typed or pasted in Visual mode that forms a well-formed
  `[@...]` (not escaped, and for a paste not followed by `(` or `[`) becomes a chip, so it is
  written as a citation rather than as `\[@...\]`. Only the text ending at the caret is turned
  into a chip, never older text, so an author's escaped `\[@...]` stays text; nothing inside code,
  a link or a protected block becomes a chip. A `(` typed straight after a chip is written as
  `\(`, so the citation never becomes a link.
- **Where the editor cannot agree with the scanner, it preserves.** A block whose `[@` text the
  visual editor cannot show as chips exactly as the core scanner reads it is a protected
  **Citation text** block, kept byte for byte: `[@` after an escaped backslash (`\\[@key]`), a
  citation followed by `(` or `[`, a malformed bracket, a citation in link text, and a citation
  that emphasis or a link would overlap. Emphasis is read with the citations masked, and `_`
  emphasis that CommonMark would not open or close inside a word does not count as holding a chip.
- **Editing in place.** In Markdown mode a selection inside (or exactly over) a citation reopens
  it; in Visual mode the chip does. Only that citation's text is replaced. New citations go at
  the end of the selection, after a space when they would touch a word (and before one when a
  `(` or `[` follows), so the selected text stays; the caret lands after the citation.
- **Refused targets.** A new citation cannot go inside code, a protected block or a link (its
  text or address) in either mode, where it would not be read as a citation or would break the
  link. The dialog checks the target when it opens and again before it asks the server: it says
  why, stays open with the author's choices, and reports the failure inside itself; Cancel
  returns focus and the selection to the writing surface.
- **Undo.** The editor keeps one undo record for the last citation applied: the exact prior
  Markdown and selection (Markdown mode) or a copy of the visual editor's nodes and caret path
  (Visual mode). Ctrl+Z or **Undo citation** restores it while the draft is unchanged since;
  after any other edit the record is dropped and native undo applies.
- Footnotes, links and protected blocks keep the existing visual-editor rules; the picker never
  edits them.

## Consequences

- Visual and Markdown modes round-trip citations byte for byte, including hand-written and
  invalid ones, which stay text for the author to fix.
- What is inserted is exactly what a build will read, because the core scanner checked it.
- A citation cannot be inserted inside code, a link or a protected block from either mode; the
  author is told so in the dialog and the draft is unchanged.
- Some hand-written lines with citations are protected blocks in Visual mode and are edited in
  Markdown mode; this is the price of never losing a citation in a visual edit.
- The citation status line is always rendered (visually hidden while idle), so assistive
  technology announces its first message.
- Other visual-editor normalization (such as `*em*` becoming `_em_` after a visual edit) is
  unchanged and outside this decision.

## Domain language

**Citation** and **Citation chip** are defined in [`CONTEXT.md`](../../CONTEXT.md).
