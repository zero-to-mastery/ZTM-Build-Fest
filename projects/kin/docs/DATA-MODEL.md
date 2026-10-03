# Data Model

**Status:** Current through v0.7.0 Routines; earlier version sections are historical contracts. See v0.7.0 below.

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
- **Item:** A lightweight household need/reminder.
- **Handoff:** Context one member wants another to know.
- **Talk:** A topic that matters but may be better discussed later.
- **Pulse:** Time-bounded context about current capacity.
- **Routine:** A recurring household need, not a general calendar entry.
- **Agreement:** A deliberately recorded household understanding, never inferred.
- **Event:** An immutable identified fact from which current state is reconstructed.

See [DOMAIN](DOMAIN.md) for definitions and release scope, and [LIFECYCLES](LIFECYCLES.md) for transition rules. Item, Handoff and Talk are implemented; see [V0.4.0](V0.4.0.md).

## Data evolution and ownership

Application, event, ABI/protocol, IndexedDB, and export-format versions are independent. Persisted event bytes remain immutable as the in-memory domain model evolves; supported older versions require explicit decoders, and unknown newer versions must not be silently skipped or rewritten. See [VERSIONING](VERSIONING.md) and [MIGRATIONS](MIGRATIONS.md).

Household members should be able to obtain a usable copy of their event data. Future portable export/import must validate and replay before changing existing state; see [PORTABILITY](PORTABILITY.md). Archival, device revocation, member removal, and full household deletion are separate operations described in [RETENTION](RETENTION.md).

## Why events

An event history can support reconstruction after reload, household history, event-derived “Since You Last Looked,” offline changes, multiple devices, and later synchronization reconciliation. Those are future capabilities, not claims that history, sync, or conflict resolution exists today. Event retention and deletion also have privacy implications described in [PRIVACY](PRIVACY.md).

## v0.5.0 Pulse

PulseState has actor_id, fixed enum value, set_at, expires_at and active/expired status. No mutable persistent Pulse table; canonical events remain the sole authority. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

`last_looked_event_id`, `last_looked_local_sequence`, and `last_looked_at` are installation-local view metadata in `local_context`, not fields on Household, Member, or Event. Rust summary records expose only source event ID, semantic kind, entity kind, text, and optional Item classification; actor and device provenance are not part of the presentation projection. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Routine occurrence identity is `(routine_id, civil period start date)`, not a random occurrence ID. Current state is derived; only definitions and human lifecycle actions persist. Civil dates use validated YYYYMMDD u32, Monday-start weeks. No time-zone preference is persisted in v0.7. See [V0.7.0](V0.7.0.md).
