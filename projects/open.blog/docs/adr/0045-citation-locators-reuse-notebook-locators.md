# ADR 0045: Citation locators are the notebook's locators, with the same ambiguity rules

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#40](https://github.com/journey-to-code-org/open.blog/issues/40)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0009](0009-research-source-library-identity.md)
- Contract: [Citation format](../specs/citations.md)

## Context

ADR 0034 defined compound, open locators for passages. A citation needs the same precision, and
the same refusal of locators that mean nothing without knowing the edition. Two locator types
would diverge.

## Decision

- A citation carries up to eight ordered `research_notes::Locator` values. Kinds are the
  library's location schemes plus `x-` extensions; kinds are never merged.
- The page and folio rules are one shared function used by the notebook and by citation
  resolution: a page needs an edition, translation or witness (a reference resolves through its
  `of` chain), and a folio needs a witness. A violation drops that citation with an
  `ambiguous-locator` diagnostic and does not stop other citations.
- Written form is `kind value` or `kind value to end`, joined by `;`. Timestamps use seconds or
  `h:mm:ss`. Values are Unicode text up to 200 characters.
- The notebook's `extra` locator fields are not part of a citation and are never public.

## Consequences

- A passage's locators can be copied into a citation unchanged.
- Locator semantics have one home; changing a rule changes both places in one edit.

## Domain language

**Locator** and **Source location** are defined in [`CONTEXT.md`](../../CONTEXT.md).
