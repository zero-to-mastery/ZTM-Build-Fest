# ADR 0046: State which CSL data survives, which is preserved verbatim and which is reported lost

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#40](https://github.com/journey-to-code-org/open.blog/issues/40)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0012](0012-source-library-interchange.md),
  [ADR 0042](0042-citation-keys-are-source-identifiers.md)
- Contract: [Citation format](../specs/citations.md)

## Context

CSL JSON is the exchange format for references and for citation items. Neither side can store
everything the other holds, and silently dropping data would break trust in an import.

## Decision

**Reference data** keeps ADR 0012 and gains one lookup, `csl_field_fate`, so the policy has a
single readable source:

| Fate | Fields | Behaviour |
| --- | --- | --- |
| stored, normalised | `id` | normalised to a source identifier as in ADR 0012 (`Smith2003` becomes `smith2003`; an id with no ASCII slug becomes a `csl-` digest) and exported as that identifier |
| stored | `title`, `language`, `issued`, `author`, `editor`, `translator`, `DOI`, `ISBN`, `ISSN`, `URL`, `PMID`, `PMCID`, `custom` | mapped to library fields and exported again; round-trips |
| preserved | `type` (other than `document`) and variables with no library field (`publisher`, `container-title`, `volume`, ...) | kept verbatim under the record's `csl` field, text or number only |
| private-dropped | `note`, `abstract`, `annote`, `keyword` | never stored and reported, so they cannot reach a public artifact |
| unsupported | anything else | not stored; the import plan reports it with a reason |

**Citation items** map to CSL's `label` and `locator`:

- Kinds `page`, `folio`, `line`, `section`, `chapter` and `timestamp` have the same CSL label.
  `canonical` and other `x-` kinds have none; `x-csl-` kinds write back their kept label.
- CSL has one locator per item. Export writes the first locator, reports each thing CSL cannot
  carry (further locators, a kind with no label, the range structure, since CSL writes a range as
  one text) as a loss, and writes the full ordered list in `openblog-locators`, which CSL
  processors ignore. Import restores that list when its first locator still agrees with `label`
  and `locator`; if someone edited those elsewhere, CSL wins and the disagreement is reported.
- A CSL label with no matching kind is kept as an `x-csl-<label>` extension kind, not dropped,
  and export writes it back as that `label`. The current CSL schema spells the sub-verbo label
  `sub-verbo`, which is kept as `x-csl-sub-verbo` and round-trips exactly; export always writes
  `sub-verbo`. The legacy spelling `sub verbo` (CSL 1.0.1) is accepted on import as an alias of
  the same kind, and the respelling is reported as a loss. A kind cannot hold a space, so any other
  label with spaces is kept with hyphens and the respelling is reported. An item without a label is a
  `page` locator, as CSL specifies.
- `prefix`, `suffix`, `suppress-author`, `author-only`, embedded `itemData` and any other field
  are reported and not stored. The library stays the only source of reference data. An item's
  `id` is normalised exactly as a reference import normalises it (`derive_id`), so a citation of
  `Smith2003` names the source imported as `smith2003`; a changed id is reported as a loss.
- Nothing contacts a service, and no style is rendered.

## Consequences

- An import never loses data without saying so, and an export-then-import of a citation is
  lossless for open.blog.
- Another tool can read the first locator and ignore the rest, at the cost of the listed losses.
- Supporting grouped citations, prefixes or suffixes later is additive.

## Domain language

**Citation**, **Locator** and **Reference** are defined in [`CONTEXT.md`](../../CONTEXT.md).
