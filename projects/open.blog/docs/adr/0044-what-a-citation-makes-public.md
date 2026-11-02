# ADR 0044: Only the citation key, its locators and the formatted reference are public

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#40](https://github.com/journey-to-code-org/open.blog/issues/40)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0004](0004-portable-projections-from-canonical-work.md),
  [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0037](0037-private-notebook-lifecycle-export-and-leak-guards.md)
- Contract: [Citation format](../specs/citations.md)

## Context

Citations will appear in public posts, while the source library and the notebook are private
author research (ADR 0004, ADR 0034). The boundary must be a short, explicit list, not a filter
over everything.

## Decision

Exactly three things become public when a post cites a reference:

1. the **citation key** (the source identifier);
2. the **locators** (kind, value and optional end, with no extra fields): a dedicated
   `PublicLocator` type with no room for the unknown fields a notebook locator keeps;
3. the **formatted reference**: a `PublicReference` built from an allowlist of the record's
   description (kind, title, creator names and roles, issued, language, identifiers in the
   publicly resolvable schemes, and the preserved CSL variables of ADR 0012), plus a
   deterministic plain-text rendering of it.

Identifiers are published only in the standard schemes CSL interchange knows: `doi`, `isbn`,
`issn` and `url` (which the library validates) and `pmid` and `pmcid` (checked for shape when
published). Any other scheme is free-form author data, such as a local file path or a private
catalogue number, and stays private.

Everything else stays private: notebook passages, excerpts, notes, concepts and links; the
archived flag and relationships; unknown record fields; identifiers in other schemes; credit
fields; and private CSL note
fields, which are never stored. Resolution takes the source library and the citations as its
only inputs, so the notebook cannot reach it by construction. A quotation or note reaches a post
only as text the author copies into it; it never rides along with a citation.

## Consequences

- Adding a field to a source record does not publish it: it must be added to the allowlist.
- A citation reveals which sources a post cites, as intended, and nothing about other research.
- The plain-text rendering is a fallback; style-accurate rendering needs a CSL processor and is
  out of scope here.

## Domain language

**Citation**, **Reference** and **Notebook** are defined in [`CONTEXT.md`](../../CONTEXT.md).
