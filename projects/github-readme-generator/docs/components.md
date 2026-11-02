# Component Library

Open **Components** or **Library → Browse Component Library**. Search names, descriptions and tags, filter thirteen categories, or select Favorites, Recently used and Saved by you. Built-ins are copied for editing; saving never mutates their definitions. Results render forty cards at a time with Show more.

Select Preview to inspect a starter, edit supported fields and view its generated Markdown. Render preview uses the same sanitizer as the main README preview. Images may contact their external hosts; lists never load remote images. Widget starters identify their upstream project and setup requirements. Placeholder image URLs need your own published output before sharing a README.

Insert at cursor without replacing selected text, before/after an explicitly selected section, or append. v0.5.0–v0.5.2 inserted generated source as Custom Markdown. v0.5.3 section insertion retains supported visual settings; raw/custom snippets and cursor insertion still use Custom Markdown. Undo restores the previous draft. Cursor insertion preserves all source. Inserting between sections detaches nothing; inserting inside a builder or component section detaches only that section, and the status names it.

Save My Snippet accepts a name, category, description, comma-separated tags and exact Markdown. Selecting editor text before opening Components pre-fills the source field. Saved source preserves line endings and template-like text; custom snippets never interpolate placeholders. Built-in supported fields use explicit escaped interpolation and safe URL validation, never evaluation.

Favorites, thirty recent IDs and up to 500 saved snippets persist locally and participate in all-drafts backup/restore. Malformed libraries use storage recovery without overwriting the original. Imports/restores resolve IDs and names without silent overwrite. Failed saves are visible. Raw Markdown/HTML in snippets is user source, not executable application code; preview sanitization never rewrites exported Markdown.

## Visual editing and ownership (v0.5.3)

Supported starters inserted before/after a section or appended to the document retain a structured component instance in Studio state. Select **Edit visually** in Sections to reopen template fields, a Widget Hub form (including saved Typing SVG settings), or the badge row editor. Save component changes updates only that section. Duplicate configured component creates an independent copy. The ordinary section duplicate control also copies settings independently.

**Save configured component preset** adds the current configuration to Saved by you. Presets are reusable across drafts and portable in snippet packs. Field presets retain their configured defaults; widget and badge presets include generated Markdown as a fallback for older readers. Unsupported future preset metadata falls back to Custom Markdown instead of being executed or guessed. Known malformed settings are rejected. Saved entries can be renamed/deleted from their detail view; inserted copies do not change.

Raw document editing detaches only the sections it touches: a touched component or builder section becomes Custom Markdown, untouched components keep their settings, and a polite status names each detached section. This protects exact user text rather than trying to reverse-engineer it. Undo restores the earlier structured state. Cursor insertion likewise uses raw source. Existing v0.5.0–v0.5.2 snippet insertions remain Custom Markdown; they are never converted retroactively. No automatic pattern recognition is performed.

If component source was changed in a Studio JSON file or another operation while its metadata remained, the customizer displays **Current Markdown** and **Generated Markdown**. Replacing that source requires explicit confirmation. If it changes again during editing, review must be repeated. **Keep current source as Custom Markdown** detaches without rewriting stored text. Unsaved visual fields have discard protection.

Favorites sort ahead of other matches; exact/prefix names rank before other tag matches, and Recently used remains ordered by usage. Only forty result cards render initially. No remote image previews render in the result list; Show more is explicit. Named controls, selected/favorite states, keyboard actions, visible focus and predictable dialog return are covered by browser tests. These checks are not a screen-reader certification.

Health gives advisory guidance for repeated components/stats images, too many widgets, excessive centering and nested layouts. Code examples and HTML comments do not count as nested markup. Nothing is removed automatically. Previews and source/export stay separate.
