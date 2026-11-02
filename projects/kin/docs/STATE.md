# Derived Household State

**Status:** Protocol 24 is the only replay format (refactor track, D3). Replay is always the distributed reduction: an owned copy sorted by `(logical_time, device_id, event_id)` with an explicit `as_of` and civil date; the catch-up summary uses input order. Modes, Item categories, planning dates and Item history dates are derived from canonical events. Browser startup obtains authorized local unlock before decrypting and replaying, and locked state holds no household projection. Version sections below are history.

## Projection pipeline

```text
ordered event stream
       |
       v
validate envelope and payload
       |
       v
apply deterministic reducer
       |
       v
HouseholdState
```

The same valid ordered event stream and explicit as_of/civil_date must always derive the same household state. Current state is a projection of events; the event history remains the underlying record. Do not persist an independently editable state snapshot as a second source of truth. A future cache may accelerate replay only if it can be discarded and rebuilt from events.

If replay later becomes expensive, a snapshot/checkpoint may accelerate reconstruction only as a verified derived projection. It is not authoritative and cannot justify deleting source events by itself. Optimization must not change observable household state; see [Retention](RETENTION.md) for the deferred event-compaction policy.

## Current HouseholdState

Keep the first projection small:

```text
HouseholdState
├── household_id: Option<HouseholdId>
├── mode: normal | vacation | guests | rest
├── items: Vec<ItemState> in original add-event order
├── handoffs: Vec<HandoffState> in original add-event order
├── talks: Vec<TalkState> in original add-event order
└── pulses: Vec<PulseState> ordered by actor_id

ItemState
├── item_id
├── text
├── created_by
├── created_at
├── classification: today | need | shopping | staple
├── status: active | completed | archived
└── steps: Vec<ItemStepState> in Step creation order

ItemStepState
├── step_id
├── text
├── completed
└── archived
```

Steps are scoped to one Item, household-unique by ID, and limited to 16
lifetime additions per Item, including archived Steps. Their text is trimmed
plain text (1–80 Unicode scalar values, at most 256 UTF-8 bytes, no controls).
Step completion never changes Item status. Mutations require an active Item;
archive retains projection history but hides the Step from active lists.

Items are identified by stable item ID, never display text. Pre-sync actor, household, and device IDs remain immutable local placeholders and are resolved only through the verified v8 identity-binding context. Schema-v1 `ITEM_ADDED` events normalize to `today`; schema-v2 events carry explicit classification. HandoffState contains handoff_id, text, created_by, created_at, and status (unacknowledged, acknowledged, archived). Acknowledgement actor/time remain in its source envelope. TalkState contains talk_id, text, created_by, created_at and open/resolved/archived status. Routines are implemented. Agreement remains unscheduled; authentication and trusted-device authorization stay service-owned rather than becoming household content projections.

## Validation and errors

Validate the complete event envelope and event-specific payload before applying a transition. Event kind and schema version must be supported, household identity must match the stream, IDs and text must meet the documented constraints, and referenced entities must exist.

An invalid event makes reconstruction fail deterministically and produces no partial state for presentation. Preserve the event bytes for diagnosis/recovery; do not silently discard an unknown event or continue with a misleading projection. Duplicate delivery follows [Events](EVENTS.md): an exact duplicate event is ignored, while a duplicate ID with different content is an integrity error.

## Replay example

Given this ordered, valid stream:

```text
ITEM_ADDED      item-17 "Buy milk"
ITEM_COMPLETED  item-17
ITEM_REOPENED   item-17
```

The resulting state is:

```text
Item item-17
text = "Buy milk"
status = active
```

The same stream is supported in v0.2.x and produces `status = active`. A v0.1.x engine does not support `ITEM_REOPENED` and fails closed.

Replaying the same supported event stream repeatedly produces structurally identical state. No reducer rule may depend on ambient current time, random values, network responses, DOM state, or iteration order of an unordered container.

## Time-dependent projections

Event timestamps are data, not an implicit clock. Features such as Pulse expiry must be projected using an explicit `as_of` instant supplied to the projection; the same events and same `as_of` value must yield the same result. Pulse is not part of v0.1.0.

## Archival and deletion

Do not physically erase a domain entity's earlier events to represent routine removal. An explicit `ITEM_ARCHIVED` transition acts as a tombstone in derived state and prevents an old event replay or disconnected device from making the item appear active again. Archived items are excluded from the active view but remain represented in history.

This does not override a person's right to request data deletion. Physical log compaction, household erasure, backup deletion, and cross-device deletion require a later privacy and synchronization design. No retention or erasure implementation exists yet.

## v0.9 Distributed Sync Boundary

A deterministic v8 total ordering makes synchronized projections reproducible; it does not decide which conflicting human intent wins. The local v0.1-v0.8 stream remains append-ordered. v8 sorts a copy for state replay while preserving original local-arrival order for catch-up boundaries. Equal-time concurrent archive/mutation behavior is documented in the v0.9 release contract; no generic CRDT or wall-clock LWW is used.

A change after another device's archive or completion is kept in history and has no effect. The archived or completed entity stays terminal: the later edit does not reopen it and does not fail replay. Creating a note in an area that another device archived at the same or an earlier logical time keeps the note with no area. A device's own later mutation of something it archived stays invalid.

## v0.4.0 Talk

HouseholdState adds talks: Vec<TalkState> beside items and handoffs. Each is ordered by its original creation event. TalkState has talk_id, text, created_by, created_at and status; no duplicated resolution metadata. Archived tombstones stay in projection/history but are hidden in normal lists. See [V0.4.0](planning/V0.4.0.md).

## v0.5.0 Pulse

HouseholdState adds pulses sorted by actor ID. Explicit rebuild_at(events, as_of) projects active iff as_of < expires_at, otherwise expired. SET replaces per actor; CLEAR removes, including absent no-op. Clock rollback may reactivate latest expired context; source events stay unchanged. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

Protocol v6 derives a structured summary after an optional stable event-ID cursor. Rust validates the cursor against the supplied ordered stream, deduplicates exact repeated delivery, excludes Pulse entries, retains the latest eight entries in event order, counts all meaningful events, and reports the actual last stream event as the through-boundary. This summary is not a second authoritative household state and contains no actor attribution. See [V0.6.0](planning/V0.6.0.md).

## v0.7.0 Routines

HouseholdState adds Routine definitions/tombstones and their current occurrence key/status. Rust replay retains historical completion by Routine ID and period key in transient memory, then projects the supplied civil date. Same events, as_of, civil_date and cursor yield identical results. Dates before creation have no occurrence; old completion never carries over. See [V0.7.0](planning/V0.7.0.md).

## v0.17.0 Checklist Steps

Rust replay appends each valid `ITEM_STEP_ADDED` to its parent Item and applies
completion, reopening, and terminal archive transitions without changing the
parent Item's status. Stable ordering follows event replay order. Capacity is
measured across the Step history, including archived entries. In distributed
replay, a same-logical-time archive from another device dominates Step
completion/reopening; a same-time parent Item archive suppresses Step mutation.
A later Step change from another device, after another device archived or
completed the Item, is kept in history and has no effect.
Older event histories remain valid and contain no Steps.

## v0.18.0 Richer Routine Scheduling

Rust derives Daily, Monday-start Weekly, creation-date-anchored every-two-weeks,
and calendar-month periods from validated explicit civil dates, alongside
as_of for Pulse. JS obtains local year/month/day from one browser clock sample;
timers only request replay. Inside occurrence append transactions, JS compares
the frozen intent key with Rust’s fresh canonical current key before candidate
replay. This is identity checking, not a browser recurrence reducer. See
[V0.7.0](planning/V0.7.0.md) and [V0.18.0](planning/releases/V0.18.0.md).

## v0.19.0 Shared Shopping Lists

Shopping is a third Item classification, encoded as code 2 under protocol 13.
It shares Item identity, status transitions, deterministic replay, encrypted
local persistence, and household synchronization. Protocols 1–12 fail closed
on Shopping-bearing history; existing Today/Needs projections remain
compatible. No new state entity or storage migration is introduced. See
[V0.19.0](planning/releases/V0.19.0.md).

## v0.20.0 Staples & Replenishment

Staples are active Items classified with code 3 under protocol 14. A
user-triggered replenish action appends a new Shopping Item with copied text;
the staple remains active and the two Item lifecycles are independent. Older
protocols fail closed rather than omit or remap Staples. No reducer entity or
storage migration is added. See [V0.20.0](planning/releases/V0.20.0.md).

## v0.21.0 Household Modes

`HouseholdState.mode` is Normal when the history contains no mode event;
otherwise it is the last mode under deterministic event replay. Vacation,
Guests, and Rest suppress routine occurrence completion/reopen actions but do
not alter Routine definitions or their prior occurrence history. The browser
keeps definitions visible and displays the pause explanation. Rust validates
the command independently of the browser.

## v0.22.0 Lightweight Planning Dates

`ItemState.planning_date` is projected from ordered date-change events. A
date event can update or clear an existing Item without relying on the
projection clock; replay does not recalculate a saved Today/Tomorrow choice.
Distributed updates use the established deterministic event order. A stale
offline date event after Item archival remains valid history, while new UI
commands cannot target archived Items.
