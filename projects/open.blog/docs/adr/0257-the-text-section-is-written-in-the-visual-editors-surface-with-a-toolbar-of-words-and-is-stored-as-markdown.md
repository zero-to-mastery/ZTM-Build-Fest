# ADR 0257: The Text section is written in the Visual editor's surface with a toolbar of words and is stored as Markdown

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#330](https://github.com/journey-to-code-org/open.blog/issues/330)
- Parent story: [#317](https://github.com/journey-to-code-org/open.blog/issues/317)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0249

## Context

A landing page's Text (`rich-text`) section was a plain box where the owner typed Markdown. Owners write
their welcome message the way they write an email. The landing page stores inert Markdown (ADR 0245: no HTML,
markup shows as typed), and Admin already has a Visual (word-processor) editor for posts with a tested
Markdown round-trip.

## Decision

- **The same round-trip, not a second editor.** The Text section's field is a `richtext` field. It draws the
  stored Markdown with the post editor's own parser (`parseVisualMarkdown`) and block renderer
  (`Editor.prototype.visualBlockElement`), edits it as a `contenteditable` text box, and writes it back with
  the post editor's own serializer (`visualBlockMarkdown`). No conversion code is copied. The post editor is
  not changed. The toolbar and the two small panels below are the only new code.
- **A toolbar of words, nothing else.** Paragraph, Heading, Bold, Italic, Link, Bulleted list, Numbered list,
  Quote, Image, Undo, Redo, each a real button at least 44px tall, named in words, with `aria-pressed` where
  it is a state. The toolbar is one tab stop with arrow keys, Home and End (a `toolbar` role), stays in view
  above the text while it scrolls, and pressing a tool from the keyboard leaves focus on the toolbar. A tap
  never moves the caret out of the text. There is one heading level, because the page sets every heading in a
  section at one level (ADR 0245). There is no Markdown toggle, no HTML view, no source button.
- **Link and Image ask in plain words, in the page, not in a pop-up.** Link asks where it goes (and, with
  nothing selected, the words to show); a link already under the caret is changed or removed as a whole.
  Image asks where the picture is and a description, which is required. Addresses are checked with the same
  rule as every other address on the page (`addressProblem`) and by the editor's `safeVisualUrl`, so only
  `https`, `mailto` and site paths reach the text. A picture that already has no description in older text is
  a problem that stops Save, in words.
- **Nothing rides along.** Paste inserts the plain text of the clipboard only, and dropping text in is
  refused, so no markup, style or script reaches the text box. Words that look like markup are escaped by the
  serializer and render as typed on the page. Blocks the box cannot edit (a table, code, raw HTML typed
  earlier) are kept byte for byte as cards that can be moved or removed, without the "Edit in Markdown"
  action the post editor offers.
- **Stored as Markdown.** The section keeps `{ "markdown": "..." }` exactly as before; the server, the schema
  and the rendering are unchanged. Opening a section and saving it without a change leaves the stored text
  byte for byte, and `landingRichRoundTrip` proves every toolbar construct survives Markdown and back.

## Considered options

- **Reuse the post editor as a component.** Deferred: it is one large class bound to a post (title, metadata,
  assistant, citations). Calling its pure block renderer and the shared serializers gives the same round-trip
  with no change to code another change is rewriting. Folding the toolbar commands into a shared module is
  left to a later change.
- **A second Markdown-only box.** Rejected: the issue asks for a word-processor surface with no Markdown view.
- **`prompt()` for links and images.** Rejected: it is not usable with a screen reader or a phone keyboard in
  every browser, and cannot require a description.

## Consequences

- The Text section looks and behaves like the Visual editor, and the Markdown a person previously typed there
  still loads, with unsupported pieces kept as cards.
- The toolbar uses the browser's editing commands (`execCommand`), as the post editor does; the result is
  always read back through the shared serializer, so what is stored is what the serializer writes.
