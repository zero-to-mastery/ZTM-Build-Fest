# ADR 0227: Interpretations disagree without a ruling, and attribution is required

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#88](https://github.com/journey-to-code-org/open.blog/issues/88)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0226](0226-a-comparison-is-its-own-public-content-type-and-one-versioned-file.md)

## Context

The point of a comparison is that scholars disagree. A model that can store a winner, score, rank,
consensus or "preferred" flag invites later features to compute one, which the project forbids:
automated behaviour must not claim truth, consensus or authority.

## Decision

- **Attribution is required and closed.** `named` (a person, school or tradition), `source` (a library
  source id, such as a commentary) or `anonymous` (an unknown author, described in the author's
  words). There is no default and no blank: not knowing who said it is stated with `anonymous`. An
  optional `certainty` (`stated`, `attributed`, `uncertain`, `disputed`) is the author's own, never
  computed.
- **No judgement vocabulary.** A file holding `correct`, `incorrect`, `right`, `wrong`, `true`,
  `false`, `winner`, `verdict`, `consensus`, `score`, `rank`, `ranking`, `rating`, `authority`,
  `authoritative`, `preferred`, `best`, `majority`, `replaces`, `replacement`, `canonical`, `body` or
  `overrides` at the top, or on an interpretation, relation or explanation, is refused, naming the
  field. Otherwise the lossless round trip (ADR 0226) would keep such a field for a later release to
  read.
- **Relations are neutral and author-written.** `differs-from` and `agrees-with` have no direction
  (the same pair twice is a repeat); `builds-on` and `responds-to` do. None says one reading is
  wrong. A relation joins two different interpretations of the same comparison. Nothing is inferred
  from wording.
- **Uncertainty and evidence stay beside the claim.** An interpretation carries an optional
  `uncertainty` note and `evidence` references that point at an Evidence Studio link or a library
  source with a locator. A reference is never a quotation, and the separation among citations,
  references, credits, claims and private notes is unchanged.
- **Translations are interpretations.** `translationOf` names another interpretation of the
  comparison and requires a `language` tag; a chain must end at an original. A translation keeps its
  own attribution, so a translator and an original author are never merged.

## Consequences

- Two readings can be published with different certainty and neither is ranked or elevated.
- A feature that wants to order readings needs a new ADR; it cannot hide behind an unused field.

## Domain language

**Interpretation comparison** and **Attributed interpretation** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
