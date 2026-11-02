# ADR 0122: The draft-side research panel inserts only checked and published research

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#61](https://github.com/journey-to-code-org/open.blog/issues/61)
- Parent story: [#24](https://github.com/journey-to-code-org/open.blog/issues/24)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0047](0047-citation-picker-in-the-visual-editor.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0085](0085-rights-are-the-authors-declaration-per-version.md),
  [ADR 0087](0087-attributed-interpretations-live-in-the-source-library.md),
  [ADR 0091](0091-copying-from-a-comparison-takes-only-selected-places-with-their-rights.md),
  [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md),
  [ADR 0099](0099-approved-datings-publish-through-the-atlas-projection.md),
  [ADR 0120](0120-the-research-workspace-is-one-admin-destination-with-one-route-namespace.md),
  [ADR 0121](0121-workspace-panels-keep-unsaved-changes-while-another-panel-opens.md)

## Context

The research workspace (ADR 0120) gathers research in one place, but writing still meant
switching to it, copying a passage by hand, and opening the Cite dialog to cite what was just
pasted. A hand-copied quotation loses its citation easily, picks up Markdown it never had (an
asterisk in the source becomes emphasis), and nothing stops a private note, an unapproved atlas
entry or an interpretation from being pasted into prose that readers will see. The notebook
contract (ADR 0034) says research reaches the public only through an explicit projection that
copies approved text into content; the draft is that content, so whatever puts research into it
has to be explicit about what it copies.

## Decision

- **One narrow, non-modal panel beside the draft.** A post's Write toolbar gains **Research**
  (`aria-expanded`), which opens an `aside` labelled "Research" beside the writing surface (below
  it under 64rem). The draft stays editable while it is open. It is labelled private research in
  words, says that only what is inserted goes into the draft, and lists each item with its kind
  and its visibility ("Private research", "Published", "Not published", "Private note") as text.
  Escape or **Close** closes it and returns focus to **Research**; choosing an item moves focus
  to the item's heading.
- **One read-only route.** `GET /admin/api/research/draft` reads the library, the notebook, the
  atlas and the alignments, each on its own, so a store that cannot be read is reported in its
  part (naming the file) while the others still work. It returns sources with the library
  revision a citation check names and each version's rights statement, labelled by the core;
  interpretations; live passages with their exact wording, language, public locators and how
  many notes link to each; live notes; and atlas entries and comparisons with whether they are
  approved. A canonical `url` is present only for an item the next build publishes: an atlas
  entry that is approved while the site publishes its atlas, a comparison that is approved while
  the site publishes comparisons and that `PublicComparison::project` accepts. An entry lists
  only the datings its page publishes (`is_dating_projected`). Archived entries and the
  notebook's extra locator fields are left out. The route writes nothing.
- **A quotation is the exact wording with its checked citation.** "Insert quotation with
  citation" asks `POST /admin/api/citations/check` for the passage's source and its locators'
  kind, value and end (as the Cite dialog does), and inserts a block quote of the wording
  followed by the returned citation, after the paragraph the caret is in. Its notes are never
  inserted, and the panel says so. Each line is written by `literalMarkdownLine`: the characters
  the visual editor escapes with a backslash (`\ * _ ` [ ]`) are escaped, and `&`, `<`, `|`, `~`,
  a block marker or list number at the start of a line and whitespace at either end are written as
  character references, so the production renderer shows the stored wording and nothing in it
  becomes markup. Blank lines at either end are dropped; one inside is a paragraph break in the
  quote. A site that turns on smart punctuation applies it to quotations as to all prose.
- **Rights are the author's statement, confirmed where it matters.** The version's rights
  statement is shown with the passage. As when copying from a comparison (ADR 0091), a quotation
  from a version whose rights are `unknown` or `rightsReserved` waits for a checkbox ("quoting it
  is my decision"); no status is read as permission.
- **A citation is one source selection.** A source gives a citation with optional locators,
  checked by the server exactly as from the Cite dialog: only the key and locators are written,
  never metadata. A citation inserted from the panel never edits the citation the caret is in; it
  goes after it.
- **Context links only to published pages.** An atlas entry, one of its published datings (its
  words, linked to the entry) or a comparison can be linked only when its `url` is present. The
  link is root-relative (`/atlas/<id>/`, `/comparisons/<id>/`), so the build applies a site's base
  path, and `contextLinkMarkdown` refuses any other address. Otherwise the item says why in
  words: private ("approve it in the research workspace"), approved while the site does not
  publish that area (naming the switch), or not publishable by the next build. An interpretation
  is never cited or inserted (ADR 0087); the panel offers a link to a published comparison that
  shows it, or a citation of the source it interprets.
- **A private note goes in only by explicit conversion.** Notes are listed only under "My
  private notes", never under "All research". "Convert to draft text…" reveals a checkbox
  saying the note becomes part of the post and readers see it once it is published; only then
  is it inserted, as the author's own paragraphs with no quotation marks or citation.
- **Insertion follows the Cite dialog's guards, in both writing modes.** A block goes after the
  paragraph (or on the blank line) the caret is in, never inside fenced or indented code or an
  HTML block; a link goes at the caret, never inside code, HTML or another link. In Visual mode
  the new elements are built by the editor's own renderer from the inserted Markdown, so they
  write the same bytes back, and an empty paragraph is replaced. The visual editor now reads
  backslash-escaped characters as text, so `\*` and `\[` round-trip instead of turning into
  emphasis or a link.
- **One undo.** Every insertion keeps the citation undo record (ADR 0047): the exact prior
  Markdown and caret, or the visual editor's nodes. Ctrl+Z, or **Undo quotation** (named for what
  was inserted), restores the draft while it is unchanged since. The draft is then previewed by
  the production renderer as any edit is.
- **Failures stay with the item.** A refused target, a stale library (`409`, after which the
  refreshed revision is used), a citation problem (`422`) or an unconfirmed step is reported
  inside the item that failed, with the author's choices kept; the draft is unchanged. Nothing
  is written to research files or browser storage, and an ended session goes to the sign-in that
  keeps the draft (ADR 0121).
- **Claims stay in Evidence Studio.** The panel links to Evidence Studio and starts a claim from
  the selected words; claims are recorded there (ADR 0073), not inserted. Each item links to its
  full panel in the research workspace, which keeps the draft while it is open (ADR 0121).

## Consequences

- An author can quote, cite and link research without leaving the draft, and a quotation always
  arrives with its citation and exactly as stored.
- Private notes, interpretations and unapproved or unpublished research cannot reach the draft
  by accident; reaching it takes a visible, deliberate step. What a post finally publishes is
  still checked before publication by #62 and enforced by #63.
- A character written as a reference shows as that reference in Visual mode (`&amp;`, `&lt;`);
  the draft renders it as the character.
- The route reads four stores on each opening and Refresh; the panel does not watch for
  changes.

## Domain language

**Draft-side research panel**, **context link** and **note conversion** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
