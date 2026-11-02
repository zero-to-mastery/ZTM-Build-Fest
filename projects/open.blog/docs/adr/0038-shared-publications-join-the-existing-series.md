# ADR 0038: Shared publications join the existing series

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#182](https://github.com/journey-to-code-org/open.blog/issues/182)
- Parent story: [#151](https://github.com/journey-to-code-org/open.blog/issues/151)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

A Post already has `series` and `seriesOrder` front matter. The site resolves them into a `Series`
(name, description, theme, cover, reading order, previous and next links) from an optional
`content/series/<slug>.md`, and falls back to an implicit series named after the slug.
[ADR 0023](0023-shared-reflections-publish-through-the-ordinary-post-pipeline.md) publishes a shared
reflection as an ordinary Post, so the question was how a collaborative work takes part without a
second concept, and what authors must approve when it does.

## Decision

- There is no collaborative-series entity. A shared publication's placement is the two values an
  ordinary Post carries, written by the publish gate as the same front matter keys. Title,
  description, theme, cover, ordering and navigation all come from the existing series model, so
  every ordinary and shared part reads and sorts as one list. Ordering, including duplicate orders
  (ties go by date) and unordered parts (after ordered ones), is unchanged existing behaviour.
- The private record holds an optional `series: { series, order }`. A participant supplies at most
  a reference and a position. Series name, description, theme and cover remain the site owner's, in
  the series file, and cannot be set from a shared publication. A reference to a slug with no file
  uses the existing implicit series and warning.
- The reference is any title of up to 120 bytes on one line (Unicode, punctuation and Markdown-like
  text included) that has a letter or digit, because the loader slugifies it. It is written
  through the ordinary front matter writer, which quotes any value that needs it, so it cannot add
  a field. Blank,
  multi-line, control or direction characters, over-long and address-less titles are refused, and a
  stored record that holds one fails to load. Refusals name the rule and never the value.
- Placement is public output, so it is part of the approval binding: `public_metadata` appends the
  reference and order, under tags no user text can contain, only when a placement exists. The
  combined preview ([ADR 0021](0021-combined-review-preview.md)) shows it beside the attribution
  as "Series: <title>, part N" (no part when unordered), so authors approve only a placement they
  were shown. Changing,
  adding or removing it invalidates every approval through the recomputed binding of
  [ADR 0020](0020-approval-snapshots-bound-to-exact-content.md), and putting it back restores the
  consent that truly covered it. A record without a placement binds, serializes and publishes
  byte for byte as before, so legacy records, approvals and posts are untouched.
- Joining an existing series adds the post to that series' reading order and navigation. That is
  the reason placement is approved and the reason nothing else of that series (including its
  other posts) is written.
- Contributor context is derived, not stored: `Site::series_contributors` lists authors from the
  posts' resolved work credits, once each, in order of first appearance reading from the first
  part. A changed or removed credit changes the answer. It reads no collaboration state, so no
  participant's private data can reach it. Rendering it on the series page is left out because
  every legacy post carries a default credit and that would change legacy output; [ADR 0040](0040-contributor-aware-series-navigation.md)
  shows it only for a series that holds a collaborative work.
- `SharedPublication::with_series` returns a new record or an error, so a refused change leaves
  the stored record, content and output unchanged. The route that sets it must call
  `ApprovalSet::reconcile` in the same write, as other metadata changes do; the Admin route and
  screen are [ADR 0039](0039-arranging-a-shared-reflections-series-in-admin.md).

## Consequences

- Named built-in series templates remain out of scope.
- The Admin control for choosing the series, and who may use it, is [ADR 0039](0039-arranging-a-shared-reflections-series-in-admin.md).
