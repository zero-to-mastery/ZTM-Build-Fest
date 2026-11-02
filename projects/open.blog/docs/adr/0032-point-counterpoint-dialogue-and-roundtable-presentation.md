# ADR 0032: Point and counterpoint, alternating dialogue and roundtable place the same markup differently

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#172](https://github.com/journey-to-code-org/open.blog/issues/172)
- Parent story: [#148](https://github.com/journey-to-code-org/open.blog/issues/148)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0031](0031-sequential-and-side-by-side-presentation.md) published two layouts and refused the
other three. This enables them without changing the structure, the reading order or the approval
binding, and without letting a layout say anything about the people in it.

## Decision

- **All five layouts are presentable.** The 422 for the other three is gone. A layout the structure
  does not name is still refused as invalid, and nothing positional or gendered is a layout or a
  field.
- **Same markup, same order.** `compose` writes what it wrote for ADR 0031 (one `section.ob-turn`
  with an `h2.ob-turn-author` per turn, in reading order). A layout only changes classes and the
  stylesheet. Columns, stagger and grid apply under `@media screen and (min-width: 48em)` only, so
  narrow screens, 400% zoom, print and a reader without CSS or JavaScript read the same sequence.
- **Point and counterpoint.** Two columns only when exactly two distinct participants are present
  (`placements`): the one who appears first takes the first lane, the other the second. With three
  or more voices it is one column (`lanes: 1`), because one speaker alone against everyone else
  would claim a split nobody chose. No field says who, and the lane is derived, never stored. A
  turn is placed in its lane column in reading order, so a pair shares a row and a lone turn sits
  alone. The layout carries no claim that anyone opposes anyone.
- **Alternating dialogue.** The lane flips only when the speaker differs from the previous turn's
  speaker, and stays when the same author continues, so an author's consecutive turns share an
  edge and A, B, C puts C on the edge opposite B. One turn per row, at most 80% wide. With one
  participant there is one lane. It is a visual stagger only; each turn is still headed by its
  author's name.
- **Roundtable.** Every participant has a place without a rule per person. The round is an
  auto-fitting grid (`repeat(auto-fit, minmax(min(100%, 16rem), 1fr))`) filled in reading order, so
  any number of participants wraps into rows whose row-major order is the DOM order.
- **Degrade honestly.** Placements are computed after missing and withdrawn turns are dropped, and
  lane counts are the lanes in use: point and counterpoint with one voice left is one lane, and a
  dialogue of one participant is not staggered. Nothing is added to stand in for the missing side; a
  published Post carries no placeholder, and the preview keeps the single uniform "Not shared with
  you" placeholder for a withheld draft only (ADR 0021).
- **Optional turn labels.** A `Turn` may carry `label`, an optional single line of at most 80 bytes
  of ordinary text (no controls, line breaks or bidi controls, not blank). It is rendered as
  `p.ob-turn-label` under the author's heading, escaped, and dropped with its turn. No layout
  supplies a default such as "Point". The label is public text, so it is part of `binding_frame`:
  editing one makes standing approvals stale. An arrangement without labels hashes exactly as
  before, because a label only adds bytes when present. Labels are the author-controlled arrangement
  record the issue asks for; there is deliberately no per-lane label, because lanes are derived.
- **Admin.** The layout list offers all five with plain help text, and each turn has a labelled
  optional "label" input beside its part. The server alone validates; the Admin repeats the line
  and length checks so the words can be specific.

## Reversibility

Additive. The `label` field is skipped when absent, so older structure files and digests are
unchanged. Posts already published keep the markup and fixed class names they were written with.
