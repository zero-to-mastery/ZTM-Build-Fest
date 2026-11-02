# ADR 0054: Every relationship is one party's assertion on cited evidence

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#48](https://github.com/journey-to-code-org/open.blog/issues/48)
- Parent story: [#21](https://github.com/journey-to-code-org/open.blog/issues/21)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md)

## Context

"Plato influenced the Stoics" is a claim someone makes, on some evidence, with some doubt.
Storing it as a bare edge presents a historian's or the author's reading as fact, and it
tempts tools to infer edges from dates ("born earlier, therefore influential").

## Decision

- **A closed set of directed kinds with typed endpoints.** `authored`, `influenced`,
  `responds-to`, `disputes`, `member-of`, `participated-in`, `developed`, `exemplifies`,
  `discusses`, `part-of`, `specializes` and `related-to`. Each names which entry kinds it may
  join. Only the stored direction is an assertion; the reverse reading ("authored by") is a
  label for display and is never stored or implied. `related-to` is the only symmetric kind,
  and a swapped duplicate of it is refused. Unknown kinds are refused, not extended.
- **No chronology kinds, no inference.** There is no "preceded" or "contemporary of" kind
  and no code path that creates or ranks an edge from `bounds`; a relationship exists only
  because someone asserted it.
- **Attribution names who.** `assertedBy` is required: `author` (the site author's own
  reading), `source` (a source-library record that makes the claim), or `named` (a person or
  group outside the library). It is not a contributor credit and grants nothing.
- **Evidence names what it rests on.** `evidence` lists source-library ids with the notebook's
  compound locators, checked by the same rules (a page needs an edition, translation or
  witness; a folio needs a witness). An evidence item may name a private notebook
  `passage`, which must exist and be quoted from the same source. A relationship with no
  evidence must say `"unsourced": true`; that explicit draft state cannot be `strong` or
  `approved`, and evidence together with the flag is a contradiction.
- **Uncertainty is first-class.** `confidence` (`tentative` default, `plausible`, `strong`) is
  how firmly the asserting party holds the claim, and an optional `uncertainty` note says what
  is doubtful. Neither measures how widely the claim is accepted.
- **Contested is never consensus.** `contestedBy` records attributed dissents, each with
  evidence or a note. A relationship's standing is derived: `asserted` with no dissent,
  `contested` with any. There is no stored standing, no "agreed" value, and a stray
  `standing` field is only an unknown field with no effect. Two parties asserting the same
  edge are two relationships, each with its own attribution; the same party cannot assert an
  edge twice.
- **Approval is consent for one item.** A relationship's `visibility` covers only that
  relationship. It is projected only when both entries it joins are approved too, so an
  approved relationship never drags a private entry into public output, and a private
  endpoint is a notice rather than an error (ADR 0053).
- **Cycles.** `part-of` (between entries of one kind) and `specializes` may not form cycles,
  and every relationship on one is reported. Influence may be mutual, so other kinds may.
  Self-relationships are refused.

## Consequences

- A reader surface (#50, #72) can always say "asserted by X, on Y, with doubt Z, disputed by
  W", and has no field from which to say "it is established".
- The chronology contract (#56) can add cited dates to entries and relationships without
  reinterpreting any edge.
- Editions and translations (#52) arrive as source-library records cited as evidence; they do
  not become entries.
