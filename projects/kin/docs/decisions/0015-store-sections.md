# ADR 0015 — Store sections for the Shopping list

Status: Accepted (#411, for the shopping mode epic #403)

## Context

Shopping mode (#404) lists items in the order they were added. In a shop,
people walk aisle by aisle: produce, bakery, dairy, frozen. Grouping the list
by store section, in the order the household walks it, saves doubling back.

Constraints:

- v1.0 formats are frozen; anything new is additive (V1.0-COMPATIBILITY).
- Rust owns domain rules (ADR 0002); the browser never derives the grouping.
- Areas (`AREA_CREATED`, `ITEM_AREA_CHANGED`) already exist, but they are
  places in the home (Kitchen, Garage). An item has one area; using areas for
  aisles would make "Dairy" a room and take the item's real area away.

## Decision

### Model: a household section list and a section per item

Two additive household event kinds:

- **`SHOPPING_SECTIONS_SET` (kind 66)**: the whole ordered list of sections,
  each `{ section_id (16 bytes), name (1–40 UTF-8 bytes) }`, at most 30. It
  replaces the previous list (last in replay order wins). A section left out
  is gone; items that pointed to it show under "Other".
- **`ITEM_SECTION_SET` (kind 67)**: `item_id`, `section_id` (all zero
  clears). Allowed for any non-archived item; meaningful for Shopping and
  Staples.

Event kinds share one number space across both logs: Simple view used 64
and Talk later's chat kind used 65, so these are 66 and 67.

### Rules (Rust)

- `set-shopping-sections`: 0–30 sections, unique ids, names trimmed, 1–40
  bytes, no duplicate names (case-insensitive). Refused otherwise.
- `set-item-section`: the item exists and isn't archived; the section is in
  the current list, or the id is zero. A change that changes nothing is
  refused.
- Replay is tolerant: an item section pointing at a section no longer listed
  projects as none. The event is kept, so listing the same section ID again
  brings the item back into it.
- Structure is checked by the strict payload codec (code 2: more than 30
  sections, a zero or repeated ID, a name not already trimmed, empty, over 40
  bytes or with control characters); the rest are command rules (code 4).
  Clients trim names before encoding, as Meals does.
- **Projection:** the KINS layout is frozen under replay protocol 24 (its
  section table has a fixed 14 entries), so the sections are read through a separate export,
  `kin_shopping_sections` (KSHS v1, [ABI](../ABI.md)), like item pictures'
  `kin_item_emojis`: the sections in the household's order, then each item
  that exists, isn't archived and whose section is listed, with its section
  ID. Items without one are absent. Sort order within a section stays as
  today.

### Behaviour

- Shopping mode and the Shopping list group by section, in the household's
  order, with "Other" last. A list with no sections looks exactly as today.
- A Staple's section is copied to the Shopping item it replenishes (the
  client appends `set-item-section` after the add, as capture does for dates
  and pins).
- Anyone who can edit lists can add, rename, reorder and remove sections
  (Household › Lists settings, and "Section…" on a Shopping row).

### Older devices

An engine older than this addition does not know kinds 66 and 67 in the
household log: as for other additive household kinds (Meals, Simple view),
that device pauses household sync with "update Kin" and keeps its data until
it updates. The V1.0-COMPATIBILITY row states this.

## Consequences

- Two additive event kinds, KCMD actions 66 and 67 and one new WASM export
  (KSHS); the KINS projection is unchanged. TEST-VECTORS gains vectors.
- Areas keep their meaning.
- The section list is small and replaced whole, so concurrent edits resolve
  by replay order without merge rules; the cost is that two people editing
  the list at once keep only the later edit, which is acceptable for a list
  this small and rarely edited.

## Alternatives considered

- **Reuse Areas.** Rejected: an item would lose its home area, and aisles
  would appear wherever areas do (notes, filters).
- **A free-text section on each item.** No shared order, typos split groups.
- **Per-section events (create, rename, move, archive).** More precise under
  concurrency, but more events and rules for a list of a dozen names.
