# Fixture conventions

- `profile-readme.md`: banner/picture preamble, badges, HTML details, fenced examples, relative assets, and widgets.
- `repository-readme.md`: documentation links, screenshot, code, table, and nested heading.
- `messy-readme.md`: comments, unusual heading levels, repeated sections, duplicate embeds, and raw HTML.
- `merge-current.md` / `merge-remote.md`: aliases, changed bodies, duplicates, and unmatched content.
- `round-trip/`: golden Markdown for source-preserving edits and the round-trip matrix (`crlf.md`, `mixed-eol.md`, `bom.md`, `no-final-newline.md`, `trailing-whitespace.md` with two-space hard breaks and tabs, `fences.md` with headings inside backtick/tilde fences, a nested four-backtick fence and an unterminated fence at EOF, and `html.md` with details, centered paragraphs, picture, comments and inline HTML). The folder is marked `-text` in `.gitattributes` so CRLF and BOM bytes survive git; never format or re-save these files. `tests/source-patch.test.js` uses them.
- `malicious-readme.md`: active HTML, unsafe URL schemes, event attributes, SVG, malformed nesting, and application CSS-class attempts. This is inert test data; never render it without the production sanitizer.

Tests also construct empty, image-only, Unicode, BOM, CRLF/mixed-line-ending, huge-heading, and 100/250 KB inputs directly. Preserve fixture source and line endings when a test requires exact round-tripping. Do not bulk-format these files. Security checks verify both sanitized preview behavior and unchanged source/export.
