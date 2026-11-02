# ADR 0260: Pasted content is converted to the editor's own Markdown through an allowlist and never enters as markup

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#334](https://github.com/journey-to-code-org/open.blog/issues/334)
- Parent story: [#319](https://github.com/journey-to-code-org/open.blog/issues/319)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0257

## Context

Both Visual surfaces (the landing Text section and the post Visual mode) pasted only the clipboard's plain
text, which was safe but threw away headings, emphasis, links and lists that owners paste from Word, Google
Docs and web pages. Passing the clipboard's HTML through to the page would let styles, scripts, event
handlers and tracking pictures in.

## Decision

- **A pure converter, `web/admin/paste.js`.** `pasteToMarkdown(html, options)` reads the clipboard HTML with a
  small tolerant tokenizer (no DOM, so nothing is ever parsed by the browser or attached to the page) and
  writes Markdown. Only paragraphs, headings, bold, italic, links, lists (nested lists are flattened, the
  editor holds one level), quotes, code and pictures with a description survive. Everything else is dropped:
  styles, classes, ids, event handlers, scripts, frames, forms, tables (their words stay), navigation, hidden
  content, comments, and tracking pictures. Google Docs wrapper bolds and Word list paragraphs are read as
  what they mean.
- **Output is Markdown, never markup.** Markdown markers in pasted words are escaped, block markers at the start
  of a line are defused, and a `<` that could open a tag is written as `&lt;`. Links keep only `https`,
  `http`, `mailto` and site paths, and an address is written so it cannot end its own link.
- **A picture needs a description.** A pasted picture with no description is left out and the owner is told in a
  plain sentence to add it with the Image button; tracking pixels and pictures that are not a web address
  (data, blob, file) are dropped quietly.
- **A second check at the surface.** The converted Markdown is parsed with the editor's own block parser; if any
  block would be kept as a preserved card, the paste falls back to the plain text. Input is bounded (1 MB of
  HTML, 400 blocks, nesting depth 100); over those the paste is plain text.
- **Plain text stays one shortcut away.** Ctrl/Cmd+Shift+V pastes the plain text, and every formatted paste says
  so in a polite status message. The landing Text section pins headings to its one level; the post editor
  keeps pasted headings below the post title.

## Considered options

- **Sanitize the HTML with DOMPurify or a DOM walk.** Rejected: a new dependency or a parse of hostile markup in
  the live document; converting to the Markdown the editor already round-trips needs neither.
- **A "Paste as plain text" button.** Deferred: reading the clipboard needs a permission prompt in most
  browsers; the keyboard shortcut and the status message cover it.

## Consequences

- Hostile clipboard HTML cannot reach the editor DOM or the saved Markdown as markup (tested with fixtures from
  Word, Docs, a web page and hostile input).
- Pasted fonts, colors and sizes are gone by design. Tables paste as their words.
