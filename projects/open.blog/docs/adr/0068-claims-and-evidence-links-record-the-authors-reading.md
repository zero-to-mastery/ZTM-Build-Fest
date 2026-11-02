# ADR 0068: A claim is a draft statement and an evidence link is the author's recorded reading

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#44](https://github.com/journey-to-code-org/open.blog/issues/44)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0042](0042-citation-keys-are-source-identifiers.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md)

## Context

Evidence Studio checks citations, but a citation says "this source exists", not "this source
backs this sentence". Authors need to record which sources support, contradict or contextualize
a claim in a draft. A tool that infers this, or scores it, would present its own guess as the
author's judgement and as fact.

## Decision

- **Claims and links, not a score.** A *claim* is a statement made in one draft post (`post`
  slug, `statement`, optional anchor, optional `uncertainty`). An *evidence link* belongs to one
  claim and names one `relation`: `supports`, `contradicts` or `contextualizes`. There is no
  truth value, rating, net total or "verified" state anywhere in the format; counts are kept per
  relation and never combined.
- **Relation is always stated, never defaulted.** A link without `relation` is refused, so a
  citation, a reference or a quoted passage alone asserts no support. Nothing creates a link
  from citation keys, text similarity or an assistant's output as the author's reading.
- **Evidence reuses the atlas shape.** A link's `evidence` is exactly the Knowledge Atlas
  evidence object (library source id, compound notebook locators, optional private `passage`
  quoted from the same source) validated by the same code, so locator rules cannot drift. There
  is no second evidence subsystem. Citation formatting is a separate concern and is never read
  or written here.
- **Attribution and provenance.** `recordedBy` reuses the atlas attribution (author by default,
  written explicitly) and `origin` is `authored` or `suggested`. `reviewState` is `unreviewed`,
  `location-checked` or `reviewed`; these are things a person did, and no code sets them. Link
  `confidence` and `uncertainty` follow ADR 0054: how firmly the author holds the reading, not
  how widely it is accepted.
- **Rationale is the author's prose**, up to 4,000 characters, per link. One evidence object per
  link keeps each relation individually reviewable and approvable.
- **Identity.** Claim and link ids are lowercase slugs unique across both. A link to an unknown
  claim, an exact duplicate (claim, relation, source, locators, passage) and a claim removal that
  would orphan links are refused. The same evidence may both support and contradict.
- **Opt-in and compatible.** Nothing reads or writes the file in posts, content, themes or
  exports. Existing articles, recipes, research and contributor data are untouched; credits are
  refused here as in the atlas.

## Consequences

- #45 can add Admin controls over `ClaimSet`; #46 derives gaps from these fields; #47 projects
  approved items. None needs a new relation or a verdict field.
