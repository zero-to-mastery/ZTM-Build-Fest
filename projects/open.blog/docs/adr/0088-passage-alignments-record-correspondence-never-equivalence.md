# ADR 0088: Passage alignments record where places correspond, never that they are equivalent

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#53](https://github.com/journey-to-code-org/open.blog/issues/53)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0084](0084-version-lineage-witness-identity-and-volumes.md),
  [ADR 0085](0085-rights-are-the-authors-declaration-per-version.md),
  [ADR 0087](0087-attributed-interpretations-live-in-the-source-library.md)
- Contract: [Passage alignments format](../specs/passage-alignments.md)

## Context

Comparing editions, translations, and interpretations (#22) needs a record of which places in
which versions the writer compares. Versions do not line up one to one: a translator splits one
sentence in two or merges two, an editor reorders lines, a manuscript lacks a passage another
witness has, and an interpretation renders only part of a place. A record that paired passages
one to one, or that called aligned passages "equivalent", would assert what the author has not
checked and what scholars often dispute. The version model (ADR 0084), notebook passages and
locators (ADR 0034), and attributed interpretations (ADR 0087) already name exact texts and
places; the atlas (ADR 0054) already attributes assertions and rests them on evidence.

## Decision

- **An alignment is a set of members.** Each member is one place: a `source` (an edition,
  translation, or witness, never a work or reference) with its own `locators` and optionally a
  notebook `passage` quoting it; or an `interpretation`, aligned as it is; or a source marked
  `absent`, which records that the version lacks the passage. Members of one source are that
  version's side. Several members may come from one version (a split), and a place may belong
  to several alignments (a merge or overlap), so the model is many-to-many. Member order and
  locators are the author's; nothing is sorted, numbered, or assumed to follow from position, so
  reordered passages need nothing special.
- **At least two versions, at least one present.** An alignment relates two or more distinct
  versions or interpretations, and at least one member has the passage. A version cannot be both
  present and absent in one alignment, a member cannot repeat, and a present source member says
  where the place is with locators or a passage. Pages cannot address a work and folios need a
  witness, as everywhere.
- **Correspondence, never equivalence.** `correspondence` is `corresponding` (the default),
  `partial`, or `divergent` (the places correspond and their content differs). There is no value
  for "equivalent" or "the same", and every label reads as the author's reading ("The author
  reads these places as corresponding"). `ALIGNMENT_NOTICE` states this for every view.
- **Original wording stays apart from normalization.** The original wording is the notebook
  passage's excerpt, stored exactly as quoted, or the interpretation's text. A member may carry
  `normalized: { text, note? }`, the author's normalization (such as composed accents, expanded
  abbreviations, or removed vowel points). It needs a passage or interpretation to normalize,
  never replaces or rewrites the original, and is stored exactly as written: no Unicode
  normalization is applied to any text, so right-to-left and decomposed text round-trips byte
  for byte. Bidirectional override and control characters are refused.
- **Attributed and evidenced.** Like an atlas relationship, an alignment carries `recordedBy`
  (the author by default, a library source such as a concordance, or a named person), optional
  `evidence` (library sources, locators, and passages such as an apparatus), a `rationale`, a
  `confidence` (`tentative` by default), and an `uncertainty` note.
- **Private only.** `visibility` is always `private` and any other value is refused. Publishing
  comparisons is #55's decision, through the publication projection, with rights statuses
  (ADR 0085); nothing in this format can mark an alignment public. (Amended by
  [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md): `approved`
  records the author's consent for the comparison projection, which publishes only while the
  site opts in; no other value is accepted.)
- **Stale places are notices.** A member whose locators no longer match the passage it names
  (the passage was re-located since it was aligned) is a `stale-locator` notice, and one resting
  on an archived source or passage is an `archived-member` notice. Neither is an error, and both
  name ids only. Nothing is relocated or re-aligned automatically.

## Consequences

- Splits, merges, reorderings, omissions, and partial renderings are all one shape, so the
  comparison workspace (#54) can show each version's side of an alignment without special cases.
- No alignment can claim two places mean the same, and no version is privileged: the order of
  members is the author's, not a ranking.
- The original and normalized forms can be compared side by side, and the author's
  normalization can never be mistaken for the source text.
- Automatic alignment, OCR, and hosted corpora stay out of scope; a later suggestion feature
  would have to record its own provenance, as claims do.

## Domain language

**Passage alignment**, **Alignment member**, **Absent member**, **Correspondence**, and
**Normalization** are defined in [`CONTEXT.md`](../../CONTEXT.md).
