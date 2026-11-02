# ADR 0016 — Taking turns on routines

Status: Accepted (owner decision, #429, for the taking-turns epic #428)

## Context

Households share chores by taking turns: bins this week Alex, next week Sam.
Kin has explicit responsibility (one owner per routine, `RESPONSIBILITY_CHANGED`)
but no turns, so families reassign by hand or not at all.

Constraints:

- PRODUCT-BOUNDARIES: no points, streaks, totals or rankings. A rotation says
  whose turn it is and who is next, never how often anyone did it.
- Rust owns the rules (ADR 0002); every device must agree on whose turn it is
  from the same history, including after offline completions on two devices.
- v1.0 formats are frozen; new events are additive.

## Decision

### Model: an ordered list and a turn

Two additive household event kinds, **68** and **69** (the next free
numbers after store sections' 66 and 67):

- **`ROUTINE_ROTATION_SET` (kind 68)**: `routine_id`, an ordered list of 2–12 member
  ids (no repeats), and the index whose turn it is now. An empty list ends
  the rotation. Setting it replaces the previous rotation.
- **`ROUTINE_TURN_SET` (kind 69)**: `routine_id`, `member_id` — "it's this person's
  turn now". Used for **Skip to next** and **Swap with…**; the member must be
  in the rotation.

### Rules (Rust)

- **The turn passes when it's done** (owner decision: not by calendar).
- **Advance on completion.** When replay applies
  `ROUTINE_OCCURRENCE_COMPLETED` for a rotating routine, the turn moves to the
  next member in the list. The occurrence key that advanced it is recorded,
  so a later `ROUTINE_OCCURRENCE_REOPENED` of that same occurrence (Undo)
  moves the turn back by one; reopening any other occurrence changes nothing.
- **Concurrency.** Completions of the same occurrence on two devices are
  already one completion (Rust ignores the duplicate), so the turn advances
  once. A `ROUTINE_TURN_SET` and a completion that race are applied in replay
  order like any events; the result is the same on every device.
- **Who is next.** Members who are removed, expired or otherwise not active
  are passed over when computing the current and next member; they come
  back into turn if they are active again. If fewer than two active members
  remain, the routine shows as having no current turn.
- **Responsibility.** While a rotation is set, the routine's owner shown
  everywhere is the current member (projection field), so Today, filters and
  Simple view's "my things" treat it as theirs. Ending the rotation leaves
  the last current member as the owner (an ordinary responsibility).
- **Who may change it.** Anyone who may edit routines (as for owners today).
- **Projection.** Each routine gains `rotation: { members, current, next }`
  or none. No count of completions per member is projected or kept.

### Older devices

As for other additive household kinds: an older engine pauses household sync
with "update Kin" and keeps its data until it updates (V1.0-COMPATIBILITY).

### Implementation notes (#429)

- **Owner.** Replay keeps the routine's ordinary responsibility equal to the
  current member whenever the turn changes, so KINS (whose layout is frozen),
  This week and `kin_my_things` show it without a new projection field in
  KINS; the rotation itself is read through `kin_routine_rotations` (KRRS) as
  `{ routineId, memberIds, current, next }`. Ending the rotation writes no
  extra event: the responsibility already names the last current member. A
  `RESPONSIBILITY_CHANGED` for a rotating routine is refused as a command and
  replays with no effect.
- **Members who are not active.** Membership is held by the service, not the
  household history, so Rust cannot pass over inactive members without
  making replay depend on something outside the events. Rust counts every
  listed member; the host applies the rule above with the members it knows
  are active (`turnAmong` in `web/wasm/kin-rotations.js`: inactive members
  passed over, no current turn with fewer than two) and, when the current
  member is not active, writes a `ROUTINE_TURN_SET` to the next active member,
  as it already clears a removed member's responsibilities. That puts the
  pass in the history, so every device agrees on the owner and the next
  completion moves on from the person actually shown.
- **Undo** remembers only the occurrence that last passed the turn; setting
  a rotation or a turn forgets it.

## Consequences

- Two event kinds, a projection field, ABI and test-vector updates.
- No statistics exist to show, by construction.
- Turns depend on completions: a skipped period (nobody completed it) keeps
  the same person's turn, which matches "it's still your turn".

## Alternatives considered

- **Assign each occurrence ahead of time** (a schedule of names). More events,
  breaks when a routine's schedule changes, and needs editing whenever plans
  change.
- **Advance by calendar** (turns change weekly whether done or not). Simpler
  but wrong for the common case "whoever's turn it is still has to do it".
- **Client-side rotation over responsibility events.** Two devices would
  compute different turns offline; Rust must own it.
