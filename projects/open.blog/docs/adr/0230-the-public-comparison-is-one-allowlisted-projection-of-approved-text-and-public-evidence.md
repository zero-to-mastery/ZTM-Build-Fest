# ADR 0230: The public comparison is one allowlisted projection of approved text and public evidence

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#88](https://github.com/journey-to-code-org/open.blog/issues/88)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0229](0229-ai-drafts-are-labelled-by-origin-and-publish-only-with-a-persons-approval-of-the-exact-text.md)

## Decision

- **One value.** `PublicComparison::project(comparison, public_refs)` is the only thing a page, feed
  or export may read. It copies named fields only: slug, title, subject; per interpretation its id,
  attribution, statement, language, translation pointer, public evidence, uncertainty and provenance;
  relations; explanations; `supplemental`. Unknown fields, digests, approval and drafting times and
  extras never leave the file.
- **Drafts publish nothing.** A draft comparison projects to nothing.
- **At least two readings.** A comparison with fewer than two publishable interpretations is withheld
  whole, because one reading is not a comparison. A published file with fewer than two is refused.
- **Private research stays private.** Evidence is projected only when it is in the `References` the
  build publishes (public sources and evidence links). Any other reference is dropped, the item kept,
  and the author told (`EvidenceNotPublic`). A reference is an id plus a locator typed for this
  purpose, so a private note, passage or rationale is never copied.
- **Dependent items follow.** A relation, translation pointer or explanation about a withheld
  interpretation is dropped.
- **Deterministic.** Interpretations and relations keep the author's order. Explanations are sorted:
  whole-comparison first, then by interpretation, then by level. `to_json` is two-space with one
  final newline.
- **Authoring checks.** `Comparison::check_references` reports every source or evidence link that
  does not exist, scoped to its item, against everything the author holds.
- **Not yet rendered.** No page, feed or export reads this value yet. #90 renders it and #91 adds
  regression coverage; both must read this projection and no other.

## Consequences

- A leak has one place to be found and one test to fail.
- Ordinary static builds need no hosted service: the projection is pure.
