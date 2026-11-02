# ADR 0233: Interpretation comparisons are listed in the boundary and found by search from the projection alone

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#91](https://github.com/journey-to-code-org/open.blog/issues/91)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0230](0230-the-public-comparison-is-one-allowlisted-projection-of-approved-text-and-public-evidence.md),
  [ADR 0232](0232-a-comparison-page-is-static-html-from-the-projection-with-levels-as-sections-a-selector-only-enhances.md)

## Context

The pages of ADR 0232 were built from the projection, but the publication boundary, the output check
and site search did not know them, so a page could not be explained in "What will be public", checked
against the manifest, or found by readers.

## Decision

- **The boundary names them.** `Projection::Interpretations` (switch `interpretations.publish`) lists each
  published comparison and the parts it copies, from the public projection only. It is absent while the
  switch is off, so every other site is described exactly as before. Nothing is withheld by name; what a
  comparison leaves out is reported at build time by id (ADR 0232).
- **The output check refuses a page the manifest does not list.** A file under `interpretations/<slug>/`
  for a draft or unknown slug fails the build.
- **Search reads the projection.** Published comparisons are search entries (title, subject, attribution
  names and approved statements), never feed items, never `llms.txt` entries and never a portable export
  entry in this release.
- **`openblog check` warns early.** While the switch is off, comparison files beside a page or post that
  would collide with `/interpretations/` produce a warning, as reading paths do (ADR 0212).

## Consequences

Regression tests prove an unapproved, stale or revoked AI draft and a private note in a published file
reach no output, and that public copy never labels a reading as verified.
Comparisons are still not in the portable export, `llms.txt` or the private-text guard; those are left for
a later decision.
