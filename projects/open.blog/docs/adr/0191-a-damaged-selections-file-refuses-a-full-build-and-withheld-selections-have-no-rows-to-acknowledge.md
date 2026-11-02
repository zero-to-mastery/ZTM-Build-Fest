# ADR 0191: A damaged selections file refuses a full build, and withheld selections have no rows to acknowledge

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#192](https://github.com/journey-to-code-org/open.blog/issues/192)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0190](0190-the-curated-manifest-is-previewed-from-the-same-resolution-the-build-uses-and-off-changes-nothing.md), [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md), [ADR 0147](0147-acknowledgements-never-resolve-a-finding-and-go-stale-when-it-changes.md)

## Context

A site that publishes curated context (`curatedContext.publish`) would silently publish none of it
if its selections file could not be read, and the author would not know why readers lost context.
A claims file that cannot be read already refuses the build for the same reason (ADR 0075). The
research-completeness contract (ADR 0146) owns one validator per private file and says which
findings refuse, which withhold and which an author may acknowledge.

## Decision

- **The selections file has a validator.** The contract gains the `selections` validator
  (`curated_selection::SelectionSet::parse`), its `selections-integrity` check and the
  `selections-file` object. It owns exactly one row, `file-unreadable`, in the integrity category,
  detected, gate `refuses`, like the integrity row of each other private file. The readiness
  report, `openblog check` and Admin's research checks name the file once, with the first
  problem's message (ids and fields, never authored text), and repair nothing.
- **It refuses only while the site publishes it.** `generate_site_with_boundary`, which a full
  build and `check` use, refuses before anything is generated, as it does for a damaged claims
  file, but only while `curatedContext.publish` is on. With the switch off the file is never
  read, so a damaged one changes nothing. An Admin save, a preview and the curation routes never
  fail because of it: the curation routes report it as a `422` naming the file and replace
  nothing, and a post save is still `200` with `build.ok` false and the file named.
- **Publishing a shared reflection is the same full build.** Publishing one writes the piece into
  content and then rebuilds, so while the site publishes curated context and the file cannot be
  read the publication is refused and rolled back, naming the file, until the author repairs it
  or turns `curatedContext.publish` off. This is deliberate (the author's curation is never
  silently dropped from a published page) and is documented at the publication code.
- **Withheld selections have no advisory rows.** A withdrawn, stale, missing, unapproved,
  cyclic or post-less selection is the author's own state, and the boundary manifest already
  lists it with its reason in Admin's What will be public, in the Selected for readers section
  and, for a stale one, as a `boundary:` warning. A second, acknowledgeable row would let an
  author silence the very prompt that tells them readers lost context, and acknowledging a
  withheld item would not publish it (the rule ADR 0146 states for a stale approval). So the
  matrix gains no advisory row and the acknowledgeable set is unchanged: the pinned list of
  what v0.39.0 let an author acknowledge is still a subset of it, and every row beyond it is
  still a source-review row.
- **Reversible.** A later release may add advisory rows without breaking a stored
  acknowledgement; none is written here.
