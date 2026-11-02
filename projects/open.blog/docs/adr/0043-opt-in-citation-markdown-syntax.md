# ADR 0043: Write citations as opt-in `[@key, locator]` Markdown that existing posts never meet

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#40](https://github.com/journey-to-code-org/open.blog/issues/40)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0042](0042-citation-keys-are-source-identifiers.md),
  [ADR 0002](0002-research-profile-and-evidence-capability.md)
- Contract: [Citation format](../specs/citations.md)

## Context

Posts are Markdown files that must stay valid in any editor and keep rendering the same. Links
and footnotes already carry references in ordinary posts. A syntax that changed their meaning, or
that fired on posts that never asked for citations, would break that promise.

## Decision

- A citation is `[@key]` or `[@key, kind value; kind value to end]` on one line. The `@` form is
  Pandoc-compatible for the common case, and CommonMark renders it as literal text, so a post
  stays readable with no citation support at all.
- Citations are opt-in: only code that calls `openblog_core::citations::scan_citations` sees
  them. The loader, renderer, search, feeds and every existing profile do not, so no existing
  article, recipe, research or contributor output changes. Wiring citations into rendering is a
  later task of this story and must be gated on a post opting in.
- The scanner reads Markdown with the renderer's parser (the same `pulldown-cmark` options) and
  looks for citations only in plain text runs, so it can never disagree with what the renderer
  shows. It does not treat as citations: fenced, indented and inline code, wherever they sit;
  raw HTML and comments; backslash-escaped brackets; links and images, including a shortcut
  `[@key]` made a link by a `[@key]: ...` definition; definitions; or footnotes, which start
  `[^`. Escapes inside a citation are read as rendered text. A bracket that starts `[@` but is
  malformed is reported with its line and left as text.
- Grouped citations (`[@a; @b]`), prefixes, suffixes and author suppression are deferred, since
  `;` separates locators. Locator text may not contain `;`, brackets, ` to ` or control and
  bidirectional override characters, so every accepted citation formats back to text that scans
  to the same citation.
- Limits: 1 MiB of Markdown, 2,000 citations per document, eight locators per citation.

## Consequences

- Authors can keep using ordinary links and footnotes for everything; citations add structure
  only where an author writes `[@...]`.
- A literal `[@handle]` in an opted-in post is reported once as an invalid or unknown key and
  stays text; escape it as `\[@handle]` to silence it.

## Domain language

**Citation** is defined in [`CONTEXT.md`](../../CONTEXT.md).
