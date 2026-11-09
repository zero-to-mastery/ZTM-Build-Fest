# Section styling

Section style edits builder-owned sections only. Custom Markdown is excluded and remains byte-for-byte unchanged. Choose a section, preview it, then save one undoable change. Plain, emoji accent, minimal prefix, terminal prompt, centered HTML, and divider headings affect an existing generated heading; they do not invent headings inside arbitrary section content. Theme-derived fields follow the active theme. Editing a style/glyph creates an explicit override, preserved on later theme changes. Reset this section to theme defaults is confirmed.

Dividers support Markdown rule, centered glyph, ASCII rule, minimal dots, or none. Choose a small built-in glyph or enter plain accent text. Center compact image/badge content is offered only for badges, badge rows, pictures, and widgets, using HTML images inside a centered paragraph. Long prose is not centered automatically.

The builder Library includes:

- Callout: quote, note, tip, warning, terminal, or plain. Text is escaped. GitHub alert markers retain a readable blockquote fallback in other renderers.
- Collapsible Details: safe summary text, an optional initially-open state, and an explicitly editable Markdown body.
- Code Sample: language, optional title, exact code, and optional collapsible/open presentation. The serializer selects a fence longer than any embedded backtick sequence.
- Two Columns: two short plain-text columns with optional headings. Content is escaped into table cells; Markdown syntax is not interpreted within them.

Tables may scroll on narrow screens. Use mobile preview and prefer linear sections for long content. README Health advises about excessive centering/dividers/prompts/glyphs, nested details and large table layouts without changing content. Code examples containing details tags are excluded from the structured nesting check.

GitHub governs actual rendering. These helpers use ordinary [GitHub Markdown conventions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections), not custom CSS or executable scripts. Preview is an approximation; exported source remains yours.
