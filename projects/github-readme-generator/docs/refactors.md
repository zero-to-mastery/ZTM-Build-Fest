# Safe Refactor Assistant

Open **Health → Safe refactors**, choose available fixes, and select **Review selected refactors**. The dialog shows complete Before and After source plus a patch-oriented Diff. Nothing changes until **Apply reviewed refactors**. Cancel or Escape leaves the draft unchanged. Changing any selection invalidates the previous review. If the draft changes while the review is open, Apply is rejected until you reopen it.

## Available transformations

| Refactor                | Conservative scope                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading hierarchy       | Reduce skipped top-level ATX levels; preserve names, inline content and closing markers. Skip nested/approximate matches and Setext/HTML rewrites.                                                                                                       |
| Alt placeholders        | Add `TODO: describe image` to empty Markdown alt or missing/empty quoted HTML alt. Never fabricate a description. Skip ambiguous duplicate alt attributes.                                                                                               |
| Light/dark pictures     | Pair adjacent standalone Markdown images with identical nonempty alt and `#gh-light-mode-only` / `#gh-dark-mode-only` URL suffixes. Skip titles, inline text, linked images and complex syntax.                                                          |
| Badge rows              | Normalize whitespace or emit a plain/centered HTML row for simple badge-only paragraphs. Preserve order, links, alt and optional image/link titles.                                                                                                      |
| Separators              | Keep the first parsed rule in a consecutive group. Leave rules between content unchanged.                                                                                                                                                                |
| Empty sections          | Remove top-level heading-only sections or unlabeled headings. Group headings can be intentional, so review carefully.                                                                                                                                    |
| Unsafe/unsupported HTML | Remove recognized complete script/style/iframe/object/form/control blocks and input/embed/stylesheet-link elements. Skip unclosed blocks and ambiguous crossing wrappers. This is not a general sanitizer or a promise to remove every unsafe construct. |
| Center wrappers         | Convert a plain center wrapper containing inline content to `p align="center"`. Skip nested block layouts and attributed center tags.                                                                                                                    |
| Simple URLs             | Trim quoted/angle-wrapped URL whitespace and normalize GitHub scheme/host casing and `www`. Preserve paths, query strings, ordering, fragments and encoded values. Do not convert arbitrary blob paths or rewrite reference definitions.                 |

Decorative images may intentionally have empty alt. TODO is a reminder, not a finished accessible description. Review heading-only sections before deleting them. Unsupported patterns remain available for manual Markdown editing.

## Source safety and ownership

Transforms produce patches against exact original UTF-16 offsets. Untouched source retains its exact characters, Unicode and line endings. Approximate ranges, code samples, comments and escaped examples are not rewritten. New picture wrappers use the document's existing newline convention. Each plan includes changed ranges and their old/new offset mapping.

Multiple fixes are calculated against the same original source. Disjoint edits are sorted and applied deterministically. Overlapping edits are rejected with an instruction to apply them sequentially; no transform silently wins. The diff lists original offsets and removed/added text for each patch, alongside full source views.

Applying uses one existing raw-editor undo checkpoint. To avoid stale settings, each builder section, component or generated section whose lines change becomes Custom Markdown (a Detachment), and untouched sections keep their ownership, even when the changes sit on either side of them. The dialog explains this before Apply, and the status after Apply names any detached section. Existing generated-source detachment metadata is retained where supported. Undo restores the complete original draft and builder ownership; redo reapplies the reviewed source. No internal refactor metadata appears in README export.

Refactors run in a dedicated worker. They are deterministic JavaScript; there is no evidence that moving these source patches into Rust would improve this release. No AI, remote requests or remote execution is involved. The before/after/diff displays use text, never injected source HTML. Preview sanitization remains independent and never changes source unless you explicitly approve a refactor that does so.

## Verification

`tests/refactors.test.js` covers every family, exact CRLF/Unicode preservation, malformed wrappers, titles, source mapping, combined edits, overlap rejection, ownership/undo and a 3,000-image plan. `tests/browser/refactors.spec.js` covers required review, cancellation, one-step undo, stale draft rejection, invalidating changed selections, offline use and 320px layout in all configured engines. Run `npm test` and `npm run test:browser:all` for the complete suite.
