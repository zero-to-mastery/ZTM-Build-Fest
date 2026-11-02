# ADR 0187: A selection publishes only the fields it lists, and always the attribution, uncertainty and evidence of its kind

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md), [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md), [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md)

## Context

The epic requires that every public field is explicitly selected, and also that curation never
produces an unattributed, overconfident or undisputed relationship.

## Decision

- **Each kind has identity fields, required fields and optional fields.** Identity (ids, kind,
  label, address) is always published so the item can be named and linked. `fields` lists the
  required and chosen optional ones, so the file shows exactly what readers get; a file that
  omits a required field or lists a field the kind cannot publish is refused
  (`required-field-missing`, `field-not-allowed`).
  - reference: required `creators`, `title`; optional `csl`, `identifiers`, `issued`, `language`.
  - contextual-entry: optional `aliases`, `source`, `summary`.
  - relationship: required `assertedBy`, `confidence`, `contestedBy`, `evidence`, `standing`,
    `uncertainty`; none optional.
  - timeline: required `assertedBy`, `confidence`, `date`, `evidence`, `note`, `placement`,
    `text`; optional `startYear`, `endYear`.
  - comparison: required `confidence`, `correspondence`, `correspondenceLabel`, `evidence`,
    `rationale`, `recordedBy`, `uncertainty`, `versions`; optional `wording`.
  - source-annotation and explanation: required `by`, `text`; optional `locator`.
- **Values are copied, never recomputed.** The value of a field is the projection's own public
  value, so a contested relationship stays `contested` with every dissenting party and a dating
  keeps who dates it and on what evidence. A required field the item does not have (no dissent,
  no doubt) is simply absent; that is an answer, not a gap.
- **Comparison wording follows its rights gate.** Wording is published only when the selection
  lists `wording` and the comparison projection published it (rights statement, 1,000-character
  limit, ADR 0092). A place whose wording the gate withheld stays identified and located and the
  selection gets a `rights-restricted` notice naming the place. Without `wording`, no wording is
  copied. A selection can never widen a rights gate.
- **Author-written text.** An annotation or explanation is the one thing a selection adds: up to
  1,000 characters of text the author approves, with a required `by` attribution and an optional
  `locator`. A locator is published, and part of the revision, only when the selection lists it in
  `fields`; an unlisted one stays in the private file. It is plain text kept verbatim; renderers
  escape it (#197). Control and
  direction-override characters are refused. It is commentary, never a quotation: a source's own
  words are published only through a rights-gated comparison. A private research note is never
  copied: the author writes the text, so what is published is what they approved.
- **Unknown fields** in a record are preserved in the file and never published. A contributor
  credit field (`credit`, `credits`, `contributor`, `contributors`), in a record or at the top of
  the file, is refused with `contributor-credit` as every other store refuses it: credits stay in
  `.credits.json` sidecars.
