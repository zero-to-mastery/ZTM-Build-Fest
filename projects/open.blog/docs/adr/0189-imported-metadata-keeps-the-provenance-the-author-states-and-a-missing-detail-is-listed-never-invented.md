# ADR 0189: Imported metadata keeps the provenance the author states, and a missing detail is listed, never invented

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0187](0187-a-selection-publishes-only-the-fields-it-lists-and-always-the-attribution-uncertainty-and-evidence-of-the-kind.md), [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md)

## Context

The source library does not record where a record's metadata came from, and the research model
distinguishes authored records from imported ones. Curation must neither hide that nor guess it.

## Decision

- **Provenance is a statement, not an inference.** A selection carries `provenance`: `authored`,
  `imported` with a `from` label the author wrote (at most 200 characters), or `unrecorded`, the
  default. The published item states it as given. A reference selected with `unrecorded`
  provenance gets a `provenance-unrecorded` notice. Nothing defaults to `authored`, and nothing
  is read from the record to fill it in.
- **A missing detail is listed.** A selected field of a reference or an entry that the record
  lacks (a source with no creators or date) is left out of the published item, named in the
  item's `missing` list and in a `missing-detail` notice. Missing values are never replaced by a
  placeholder, a guess or a value inherited from another version. Both notices travel with the
  published item, so what the author and the reader are told is the same (ADR 0194).
- **Version distinctions survive.** An edition, translation or witness is a reference of its own;
  selecting a work never selects its versions, and a translation is never published as its
  original. A comparison keeps each version's makers and attribution certainty as its projection
  states them.
- **Rights and uncertainty are copied.** A version's rights statement is part of a comparison;
  confidence, uncertainty notes and dissent are required fields (ADR 0187). Rights statements are
  the author's own, never a legal judgement.
