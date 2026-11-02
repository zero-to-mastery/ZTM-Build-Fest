# ADR 0237: Reader annotations are one reader-private local document, never research notes and never public

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#84](https://github.com/journey-to-code-org/open.blog/issues/84)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0034, ADR 0076
- Serves: [#85](https://github.com/journey-to-code-org/open.blog/issues/85), [#86](https://github.com/journey-to-code-org/open.blog/issues/86), [#87](https://github.com/journey-to-code-org/open.blog/issues/87)
- Contract: [Reader annotations](../specs/reader-annotations.md)

## Context

A reader who highlights a passage, writes a note, saves a source or strings them into a trail is
keeping their own reading record. An author's research notebook (ADR 0034) looks similar, holding
quoted passages and notes, but it belongs to the author, lives in the content directory and is
governed by the publication projection. Treating the two as one would let a reader's private words
drift toward an authoring surface or a public page, and would make a reader-side feature depend on
Admin.

## Decision

- **A separate document.** Reader annotations are one JSON document with its own format name,
  `openblog.reader-annotations`, version 1. It holds `annotations` (highlights and notes), `sources`
  (saved sources) and `trails`. It shares no id space, file, field or code path with the research
  notebook, and a notebook, a reading path or any other JSON is refused as `wrongFormat`.
- **Reader-owned and local.** The document is created, kept and read in the reader's own browser.
  The build, Admin and the hosted service never read it, so there is no Rust twin of this contract
  and no account, sync or cloud identity. Cross-device sync, shared or social annotations and author
  access are out of scope.
- **Never public.** `privacy.scope` is always `reader-private`; any other value is refused. Nothing in
  open.blog publishes a reader's annotations, and the publication projection has no input from them.
- **Annotations are not authoring data.** A highlight is not a citation, a reference, a claim, an
  evidence link or a contributor credit, and a reader note is not a research note. A reader record
  never becomes one by being moved; there is no conversion.
- **Opt-in.** Pages and posts without annotation features build and read exactly as before.

## Consequences

- #85 to #87 consume one validated shape and have nothing to decide about identity or privacy.
- Because only the browser holds the data, a cleared browser loses it unless the reader exported it
  (ADR 0239).

## Domain language

**Reader annotation document**, **Highlight**, **Reader note**, **Saved source** and **Reading trail**
are defined in [`CONTEXT.md`](../../CONTEXT.md).
