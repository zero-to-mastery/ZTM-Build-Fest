# ADR 0030: One deterministic reading order serves every layout, and the arrangement is approved

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#170](https://github.com/journey-to-code-org/open.blog/issues/170)
- Parent story: [#148](https://github.com/journey-to-code-org/open.blog/issues/148)

## Decision

- The linear order is rounds in order, then turns in order. It is the same for every layout and for
  a reader without CSS or JavaScript. A layout may arrange it visually but never reorders it. Once
  #173 wires it, the portable equivalent can share it too; until then nothing outside this module
  uses it, and the published Post is unchanged.
- A round's round prompt belongs to its first entry, so it is read once, before the answers.
- A turn with nothing to read keeps its place; the order never shifts when someone has not written.
  A participant with no turn simply has no entry. Unequal turn counts are normal.
- **Scoped by requester.** The public `reading_order_for` takes a requester and reads each turn
  through `DraftSet::view`, so it can never show more than
  [ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md) and
  [ADR 0018](0018-reveal-policy-readiness-and-comparison.md) allow. A draft the requester cannot
  read, a withdrawn draft, an unwritten draft and a blank part are one identical placeholder entry
  with no prose and no flag that tells them apart, as in
  [ADR 0021](0021-combined-review-preview.md). The unscoped `reading_order` is crate-private, for
  the publish gate and assembly only, like `DraftSet::latest_view`.
- If a turn names a participant the contract lacks, or a part that does not exist in a draft the
  requester can read, the order returns an error and no entries, so a stale structure cannot show
  part of a reflection or reveal what was missing. A part of a draft the requester cannot read is
  not checked, so the error never discloses an unreadable draft's size.
- **The arrangement is approved.** Choosing a layout does not alter prose, but the turn order, the
  round prompts and the layout are what readers see, so once the structure is wired they all join
  the [ADR 0020](0020-approval-snapshots-bound-to-exact-content.md) binding, together with the round
  ids and the (draft, part) of every turn. `ReflectionStructure::binding_frame()` is a prose-free
  digest of exactly those, without the revision counter. A later task appends it to the
  `ApprovalSubject` metadata, so changing any of them makes existing approvals stale like a change to
  prose or to the author set. This decision wires nothing; it fixes what the digest covers.
- This amends the participant-order rule of
  [ADR 0023](0023-shared-reflections-publish-through-the-ordinary-post-pipeline.md) for structured
  reflections (see the "Amended by 0030" note there): when a structure exists, section and credit
  order follow its reading order, and credits stay one entry per participant, at their first
  appearance. A publication without a structure keeps participant order.

## Reversibility

This adds a pure module and tests; it persists nothing and publishes nothing, so it is fully
reversible.
