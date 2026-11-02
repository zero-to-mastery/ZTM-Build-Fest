# ADR 0042: A citation names a reference by its source identifier, never by a new identity

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#40](https://github.com/journey-to-code-org/open.blog/issues/40)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0034](0034-private-passages-and-research-notes.md)
- Contract: [Citation format](../specs/citations.md)

## Context

Four ideas sit close together and are easy to blur: the in-text **Citation**, the **Reference**
it points at, the **Source location** stored on a reference, and the **Locator** a notebook
passage uses. Issue #92 gives the source library to the research-sources story (#17) and
citations to #19, and other epics consume stable source identities. A second identity scheme
(a BibTeX-style key table, or keys derived from titles) would let a citation drift from the
record it names when a title is corrected.

## Decision

- The **citation key is the source identifier** (ADR 0009): a lowercase ASCII slug of at most
  64 bytes. There is no separate key registry, alias table or derived key, so a citation either
  resolves to exactly one record or is reported.
- A key may name any source-library record, including an archived one, which keeps resolving.
  Authors cite the record whose pages they mean: a page locator on a bare work is refused
  (ADR 0045).
- **Citation** is the in-text pointer (key plus locators). **Reference** stays the source-library
  record. **Source location** stays a position stored on a reference record, describing where the
  reference sits in its work. A **Locator** is a position given at the point of citation, and is
  the notebook's `Locator` type, not a copy of it. A citation never changes a record, and a
  record never stores citations.
- A citation does not assert that its source says what the author claims, that it is
  authoritative, or that quoting it is permitted.

## Consequences

- The CSL export already uses the source id as the CSL `id` (ADR 0012), so a citation key and a
  CSL citation-item id are the same string.
- A CSL item whose id has no usable slug imports under a `csl-` hash id (ADR 0012); that id is
  the citation key. The original CSL id is not remembered.
- Unicode keys are not supported; Unicode is supported in titles, creators and locator values.

## Domain language

**Citation**, **Reference**, **Locator**, **Source location** and **Source identifier** are
defined in [`CONTEXT.md`](../../CONTEXT.md).
