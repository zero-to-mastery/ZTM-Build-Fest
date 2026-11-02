# ADR 0031: Sequential and side-by-side presentation is markup in reading order, placed by CSS

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#171](https://github.com/journey-to-code-org/open.blog/issues/171)
- Parent story: [#148](https://github.com/journey-to-code-org/open.blog/issues/148)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0029](0029-reflection-structure-is-separate-from-layout.md) and
[ADR 0030](0030-one-deterministic-reading-order.md) defined the structure, the reading order and the
digest that binds the arrangement to approval, and wired none of it. This is the first task that
stores a structure, lets someone choose it, publishes it and shows it.

## Decision

- **Storage.** A structure is one small private file per publication under
  `.openblog/private/collaboration/structures/`, beside the drafts, saved by compare-and-swap on the
  exact file text and by the structure's own `revision` (a write names the revision it read, `0` for
  none). Absent means nothing was arranged. A malformed file is an error, never "no arrangement".
- **Who can change it.** A new action, `ArrangeReflection`, goes through `SharedPublication::authorize`
  and is held by site owners and coordinators, like the reveal policy. Every member may read the
  arrangement (`ViewPublication`): it holds round prompts and turns but no prose, no part counts and
  no draft state. The routes are `GET`/`PUT /admin/api/collaboration/reflection`; the router's
  existing deny-by-default, session and CSRF checks apply. Everyone else gets the same not-found as
  a missing publication. A published reflection's arrangement is closed (409).
- **No oracle.** Saving reads no draft, so it cannot tell a coordinator who is not entitled to a
  draft whether a part exists. It checks shape, participants and that the layout is presentable. A
  turn naming a part that is not there is caught by the combined preview and the publish gate, which
  read as the requester or as the gate. (Amended in #188: the gate evaluates the approvals first,
  before it reads any draft, so a coordinator who may arrange but not read gets the same refusal
  whether or not the part exists. Only when the approvals are met does a turn naming a missing part
  get its own error, `ArrangementMismatch`, which asks a coordinator to arrange the piece again
  and names no part, author or prose. Until then the combined preview, scoped to what each author
  may read, is where authors see that the arrangement no longer matches the drafts.)
- **Presentable layouts.** (Superseded by [ADR 0032](0032-point-counterpoint-dialogue-and-roundtable-presentation.md): all five layouts are now presentable.) Only sequential and side-by-side are chosen or rendered
  (`ReflectionLayout::is_presentable`). The other three are valid structure values that are refused
  rather than silently shown as sequential; point-counterpoint and dialogue turns are out of scope.
- **Approval.** One subject builder, `assembly::with_subject`, binds the public metadata, then the
  structure's `binding_frame()`, then the synthesis's binding frame (ADR 0025), and passes the
  synthesis's attributed authors. The gate (`assemble`), the combined preview (`preview::build`),
  the approve route, the scheduled recheck and the reconcile step all take an
  `Option<&ReflectionStructure>` and build the subject through it. With no structure nothing is
  appended, so approvals given before one existed stay valid until one is saved. A layout, turn order or round prompt change makes
  standing approvals stale at the real gate, and the saving request also drops them, as a draft
  save does. Re-saving an identical arrangement under a newer revision changes nothing a reader
  sees and keeps approvals.
- **Order.** With a structure, sections and credits follow `reading_order` (unscoped, for the gate
  and assembly): credits are one per participant at their first appearance, and a participant
  absent from the structure is neither published nor credited. A blank part is skipped. Without a
  structure, participant order is unchanged.
- **Markup.** `reflection::compose` writes the same arrangement for the Post and the preview: a
  `div.ob-reflection.ob-reflection-<layout>.ob-lanes-<n>`, a `div.ob-round` per round, an optional
  `p.ob-round-prompt` once, and per turn a `section.ob-turn.ob-lane-<i>` with its own
  `h2.ob-turn-author` carrying the participant's display name, then the part. The DOM order is
  exactly the reading order; classes name lanes and the stylesheet places them, with no inline
  style, script or position written. Names and round prompts are escaped. The published sections
  still pass the existing unsafe-markup check as separate sections, so a part cannot open a fence,
  reference or footnote that changes another.
- **Responsive rule.** Side-by-side lanes apply only under `@media screen and (min-width: 48em)` and
  only for two or three lanes. Narrower screens, 400% zoom (a 320px viewport), print, four or more
  lanes, and a reader without CSS or JavaScript all read top to bottom in the same order. Long
  sections do not stretch the other lane (each row aligns to its start) and long words wrap. The
  rules live in `web/base.css` and, identically, in `reflection::LAYOUT_CSS` for the preview, which
  loads nothing else; a test keeps them equal.
- **Part marker.** The marker line is never rendered. Parts exclude it. A draft shown whole
  (no structure) has its marker lines removed, joined by a blank line so parts stay separate
  paragraphs (`strip_part_markers`), in the preview and the assembled Post alike. Otherwise the
  HTML comment would trip the unsafe-markup check.
- **Preview.** With a structure the preview is arranged. A turn of a draft the requester may not read
  at its latest revision is one uniform placeholder, so the arrangement shows no more than the
  sections do. An arrangement that cannot be read against the drafts makes the piece incomplete,
  so no approval token is issued for it.
- **Admin.** The "Shared reflections" view gets a "Layout and arrangement" panel (radio layout choice,
  per round prompts, turns with move up/down/remove, add turn/round), read-only for those without
  the grant, and a "Start a new part" button in the draft editor that inserts the marker line.

## Reversibility

Everything is additive and reversible. The structure file can be deleted to return to participant
order (which invalidates approvals bound to it). Posts already published keep their markup as
written; it uses only fixed class names.
