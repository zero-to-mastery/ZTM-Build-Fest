# ADR 0200: Nothing published means nothing written, and a refused file is left out whole

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#197](https://github.com/journey-to-code-org/open.blog/issues/197)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0190](0190-the-curated-manifest-is-previewed-from-the-same-resolution-the-build-uses-and-off-changes-nothing.md), [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md)

## Context

Existing sites must build exactly as before, a site that curates but currently publishes nothing is not
a site with a new empty file, and a failure of one object must not take the page down or write a gap.

## Decision

- **Off is the legacy build.** While `curatedContext.publish` is off the selections are never read and
  no file, section, manifest projection or guard allowance exists: every output is what it was, byte for
  byte, except the shared stylesheet that now also carries the section's rules.
- **No published selection, no file.** A site that curates but publishes no selection (none, or all
  withdrawn, stale or for no published post) writes no file, lists none and renders no section: it
  builds exactly as it did with the switch off.
- **Failures are object-scoped and non-destructive.** A refused projection (over a bound, or not
  consistent) leaves out the data file only, with a `boundary:` warning and a withheld item in Admin's
  preview; the pages' sections, the selections and every other projection are unaffected. A refusal
  never names an item's text. Nothing is written into the private files.
- **B3 is untouched.** `atlas-query.json`, the atlas pages and the `atlas:` concept links are derived
  from the published atlas alone and are byte for byte the same with or without curation; the
  `atlas:` leak guard is unchanged.
- **Deterministic.** The same site builds the same bytes, in the same order, every time.
