# Data Model

**Status:** Current through v0.25.0 Search & Filters; earlier version sections are historical contracts. Search derives results from the existing unlocked projection and adds no entity, event, or persistent index. See v0.7.0 and v0.18.0–v0.25.0 below.

## Event-oriented source of truth

Kin records household changes as an append-oriented event stream rather than treating a mutable UI snapshot as the historical record:

```text
09:13 ITEM_ADDED item-12 "Buy milk"
11:42 ITEM_COMPLETED item-12
```

Current state is derived by validating and replaying events in a deterministic order. A future cache may accelerate reconstruction, but the event stream remains the domain source of truth. State and error behavior are specified in [STATE](STATE.md); immutable event shape, naming, identity, ordering, and validity are specified in [EVENTS](EVENTS.md).

## Conceptual event envelope

```text
Event
├── event_id
├── household_id
├── actor_id
├── device_id
├── timestamp
├── logical_time
├── kind
├── event_version
└── payload
```

The envelope is a domain contract, not the JS/WASM byte encoding. The field meanings, local and future distributed ordering, idempotency, and invalid-event behavior are defined in [EVENTS](EVENTS.md). v0.4.x uses local placeholders, Item kinds 1–4, Handoff kinds 5–7 and Talk kinds 8–11; legacy bytes remain readable.

## Conceptual entities

- **Household:** One private shared coordination space with stable identity.
- **Member:** A person with identity distinct from their devices and credentials.
- **Device:** A browser installation that may later be authorized, trusted, and revoked.
- **Credential:** An authenticator associated with a member; not itself a member or household key.
- **Item:** A lightweight household reminder classified for Today, Needs,
  Shopping, or Staples.
- **Handoff:** Context one member wants another to know.
- **Talk:** A topic that matters but may be better discussed later.
- **Pulse:** Time-bounded context about current capacity.
- **Routine:** A recurring household need, not a general calendar entry.
- **Area:** Optional, flat place/context for supported household content. Areas
  have stable IDs and archived state; they are not folders, projects, workspaces,
  or permission boundaries.
- **Agreement:** A deliberately recorded household understanding, never inferred.
- **Event:** An immutable identified fact from which current state is reconstructed.

See [DOMAIN](DOMAIN.md) for definitions and release scope, and [LIFECYCLES](LIFECYCLES.md) for transition rules. Item, Handoff and Talk are implemented; see [V0.4.0](planning/V0.4.0.md).

## Data evolution and ownership

Application, event, ABI/protocol, IndexedDB, and export-format versions are independent. Persisted event bytes remain immutable as the in-memory domain model evolves; supported older versions require explicit decoders, and unknown newer versions must not be silently skipped or rewritten. See [VERSIONING](VERSIONING.md) and [MIGRATIONS](MIGRATIONS.md).

Household members should be able to obtain a usable copy of their event data. Future portable export/import must validate and replay before changing existing state; see [PORTABILITY](PORTABILITY.md). Archival, device revocation, member removal, and full household deletion are separate operations described in [RETENTION](RETENTION.md).

## Why events

An event history can support reconstruction after reload, household history, event-derived “Since You Last Looked,” offline changes, multiple devices, and later synchronization reconciliation. Those are future capabilities, not claims that history, sync, or conflict resolution exists today. Event retention and deletion also have privacy implications described in [PRIVACY](PRIVACY.md).

## v0.5.0 Pulse

PulseState has actor_id, fixed enum value, set_at, expires_at and active/expired status. No mutable persistent Pulse table; canonical events remain the sole authority. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

`last_looked_event_id`, `last_looked_local_sequence`, and `last_looked_at` are installation-local view metadata in `local_context`, not fields on Household, Member, or Event. Rust summary records expose only source event ID, semantic kind, entity kind, text, and optional Item classification; actor and device provenance are not part of the presentation projection. See [V0.6.0](planning/V0.6.0.md).

## v0.7.0 Routines

Routine occurrence identity is `(routine_id, civil period start date)`, not a random occurrence ID. Current state is derived; only definitions and human lifecycle actions persist. Civil dates use validated YYYYMMDD u32, Monday-start weeks. No time-zone preference is persisted in v0.7. See [V0.7.0](planning/V0.7.0.md).

## v0.18.0 Richer Routine Scheduling

Routine cadence retains Daily and Monday-start Weekly and adds every-two-weeks
anchored to `created_on`, plus calendar-month periods keyed by day one.
Completion remains keyed by `(routine_id, period start date)` and never
automatically resets or creates events. The source `created_on` anchors every
device's biweekly schedule; the supplied civil date selects the current period.
No reminder, assignment, streak, or calendar entity is introduced. See
[V0.18.0](planning/releases/V0.18.0.md).

## v0.19.0 Shared Shopping Lists

Shopping is a third Item classification, not a separate entity or event
family. Shopping Items use the existing canonical add, completion, reopening,
and archive events, and therefore inherit local-first persistence, encrypted
sync, and archive import/export behavior. Protocol 13 adds classification code
2; protocols 1–12 reject Shopping-bearing state rather than silently projecting
it into Today or Needs. No persistent storage migration is required. See
[V0.19.0](planning/releases/V0.19.0.md).

## v0.20.0 Staples & Replenishment

Staples are reusable Items with classification code 3, not a separate entity
or inventory model. A member can manually add the staple's text as a new,
independent Shopping Item; the source staple remains active. Both records use
canonical Item events and share encrypted persistence, sync, and archive
behavior. Protocol 14 adds Staples while protocols 1–13 reject Staple-bearing
history or projections. See [V0.20.0](planning/releases/V0.20.0.md).

## v0.21.0 Household Modes

Household mode is a closed four-value projection (`normal`, `vacation`,
`guests`, `rest`) derived from canonical mode-change events. Histories without
a mode event default to `normal`. A non-Normal mode pauses routine occurrences
but does not mutate routine definitions or create per-occurrence records.
Mode is household-wide context, not a member/device preference or a schedule.
See [V0.21.0](planning/releases/V0.21.0.md).

## v0.22.0 Lightweight Planning Dates

`ItemState.planning_date` is `Option<CivilDate>`, derived from schema-1
`ITEM_PLANNING_DATE_CHANGED` events. The date is Gregorian `YYYYMMDD` in the
supported year range 0001–9999; zero in the event payload means clear. It has
no time, time zone, reminder, or automatic rollover. A new Item has no
planning date; the user edits it afterward as a separate canonical event.
Archived Items remain hidden from ordinary lists and read-only in the UI, but
a previously authored stale offline date event still replays so it cannot
invalidate shared history. See [V0.22.0](planning/releases/V0.22.0.md).

`ItemState.last_changed_at` is a derived event timestamp, initialized from
`ITEM_ADDED` and advanced when replay changes the effective Item area,
planning date, status, or checklist-Step state. Idempotent/no-op events leave
it unchanged; equal-time distributed events use canonical replay order.
Protocol 17 exposes the value, while the UI displays only its local date and
does not expose an actor, device, exact time, read receipt, or timeline. It is
not a separately persisted field. The timestamp uses the source event clock,
so device clock skew can make the shown date appear earlier or later; replay
ordering is determined by logical time and stable identity, not wall time.
The browser formats the timestamp in the viewing device's local time zone, so
the date can also differ across devices in different time zones.

## v0.15.0 Areas

`AreaState { area_id, name, archived }` is derived from canonical Area events.
Items carry `area_id: Option<AreaId>`; other entity classes are not assigned in
this line. No Area is a valid state. Archived associations remain intact and
visible as historical context. Households can create at most 32 Areas over
their lifetime, including archived Areas. There are no nested Areas or hard
deletion. See [Household Events](EVENTS.md) and [v0.15.0](planning/releases/V0.15.0.md).
