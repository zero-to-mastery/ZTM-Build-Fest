# Household Events

**Status:** Current through v0.10.0. Rust owns canonical command encoding and decoding; existing schemas/kinds and immutable bytes remain unchanged. Protocol v8 supplies verified identity context and deterministic distributed replay. Local encryption wraps those bytes without rewriting them. Earlier version sections remain historical contracts.

## Canonical record

Kin uses an append-oriented event stream as the canonical historical record. Current mutable UI state is a projection, not a competing source of truth.

The conceptual envelope is:

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

Fields are specified now to avoid casually changing identity semantics later. The initial release may use local placeholder identities and a simpler local order; it does not implement household membership or sync.

- **event_id:** Opaque globally unique event identity. Must be generated without relying on a shared sequential database counter so independent offline devices can create events without collisions. A random 128-bit identifier is a suitable direction; exact generation and collision handling belong in the implementation contract.
- **household_id:** Stable opaque identity for the household to which the event belongs. v0.1.0 uses a locally persisted placeholder, not a server-registered household.
- **actor_id:** Stable member identity for the person who initiated the event. v0.1.0 uses a temporary local actor placeholder.
- **device_id:** Stable identity for the originating installation. v0.1.0 uses a local installation placeholder; it is not a trusted-device credential.
- **timestamp:** UTC wall-clock creation time for display and audit context. It is not sufficient to order distributed events and must not by itself control deterministic replay.
- **logical_time:** Non-negative logical ordering counter. In v0.1.0, local append order is authoritative and the counter can correspond to local order. In v0.9 synchronized v8 replay, a device advances beyond the greatest logical time it has observed before creating a causally later event; equal values represent concurrent events.
- **kind:** One canonical uppercase past-tense fact name from the event catalogue below. Do not mix imperative (`ADD_ITEM`) and fact (`ITEM_ADDED`) styles.
- **event_version:** Version of this event payload schema, distinct from the Kin application version, overall JS/WASM protocol version, IndexedDB schema, and portable export version. See [VERSIONING](VERSIONING.md).
- **payload:** Minimal, kind-specific validated data. For an item event this includes the stable item ID; `ITEM_ADDED` also carries its user-entered text.

## Event naming and availability

Use uppercase entity/action-past-tense names consistently. The milestone column records assigned scope; Item, Handoff and Talk events are implemented; later events remain planned.

| Event kind                     | Planned milestone | Purpose                                                      |
| ------------------------------ | ----------------- | ------------------------------------------------------------ |
| `ITEM_ADDED`                   | v0.1.0            | Add an item with stable item ID and text.                    |
| `ITEM_COMPLETED`               | v0.1.0            | Mark an existing item completed.                             |
| `ITEM_REOPENED`                | v0.2.0            | Reopen a completed item; active is a valid no-op.            |
| `ITEM_ARCHIVED`                | v0.2.0            | Tombstone an active/completed item without deleting history. |
| `HANDOFF_ADDED`                | v0.3.0            | Add a short household handoff.                               |
| `HANDOFF_ACKNOWLEDGED`         | v0.3.0            | Record receipt of a handoff.                                 |
| `HANDOFF_ARCHIVED`             | v0.3.0            | Archive a handoff.                                           |
| `TALK_ADDED`                   | v0.4.0            | Capture a topic for later discussion.                        |
| `TALK_RESOLVED`                | v0.4.0            | Mark a Talk item resolved.                                   |
| `TALK_REOPENED`                | v0.4.0            | Reopen a resolved Talk item.                                 |
| `TALK_ARCHIVED`                | v0.4.0            | Archive a Talk item.                                         |
| `PULSE_SET`                    | v0.5.0            | Set time-bounded capacity context, including expiry.         |
| `PULSE_CLEARED`                | v0.5.0            | Clear current Pulse context.                                 |
| `ROUTINE_CREATED`              | v0.7.0            | Define a recurring household need.                           |
| `ROUTINE_OCCURRENCE_COMPLETED` | v0.7.0            | Complete a routine occurrence.                               |
| `ROUTINE_OCCURRENCE_REOPENED`  | v0.7.0            | Reopen a routine occurrence.                                 |
| `ROUTINE_ARCHIVED`             | v0.7.0            | Archive a routine definition.                                |
| `HOUSEHOLD_CREATED`            | v0.8.0            | Establish a household identity when pairing is introduced.   |
| `MEMBER_INVITED`               | v0.8.0            | Record a member invitation.                                  |
| `MEMBER_JOINED`                | v0.8.0            | Record accepted household membership.                        |
| `MEMBER_REMOVED`               | v0.8.0            | Record explicit member removal.                              |
| `DEVICE_AUTHORIZED`            | v0.8.0            | Authorize a device for a member.                             |
| `DEVICE_REVOKED`               | v0.8.0            | Revoke a device's future authorization.                      |
| `AGREEMENT_CREATED`            | Unscheduled       | Record a deliberately created agreement.                     |
| `AGREEMENT_REVISED`            | Unscheduled       | Record a deliberate revision.                                |
| `AGREEMENT_ARCHIVED`           | Unscheduled       | Archive an agreement.                                        |

“Since You Last Looked” is a derived view of events, not a new event kind. v0.4.x supports Item kinds 1–4, Handoff kinds 5–7 and Talk kinds 8–11. Handoff/Talk kinds use schema 1; later kinds are deferred. Existing event kind codes remain unchanged. Event schema v1 `ITEM_ADDED` contains no classification and normalizes to Today. Schema v2 `ITEM_ADDED` adds a fixed classification byte (`0 = Today`, `1 = Need`) and three zero reserved bytes before the text length. New instances write schema v2 for adds and schema v1 for the other Item events. Protocol and event version compatibility is specified in [ABI](ABI.md) and [VERSIONING](VERSIONING.md). The unscheduled agreement events are not a release commitment.

## Immutability and corrections

Once persisted, an event is immutable. Correct or reverse a prior fact by appending a later event, never by rewriting the old event. For example:

```text
ITEM_ADDED
ITEM_COMPLETED
ITEM_REOPENED
```

This preserves replay, history, offline synchronization, derived change summaries, and auditable conflict handling. Event retention and user-requested data deletion remain explicit privacy concerns; see [Privacy](PRIVACY.md).

## Identity and ordering

Event IDs must be opaque and collision-resistant across independent offline devices; sequential database IDs alone are not suitable as the global identity. A duplicate ID with byte-identical canonical content is a repeated delivery and is ignored after its first application. The same ID with different content is a deterministic integrity error, not a last-write-wins replacement.

For v0.1.0, events are replayed in persisted `local_sequence` order. A single IndexedDB read/write transaction over `events` and `local_context` reads the current full event stream and logical counter, builds the candidate event, synchronously asks Rust to validate/replay that candidate stream, then appends the event and advances the counter before the transaction completes. The event is not visible as accepted until transaction completion. IndexedDB serializes overlapping read/write transactions, so tabs cannot independently reserve the same local order. `local_sequence` and `logical_time` both reflect committed local append order; the counter update and append either both commit or both abort. Timestamps never reorder the local log.

For future sync, retain originating device identity and logical time. The initial ordering requirement is a deterministic total tie-break tuple `(logical_time, device_id, event_id)` using a fixed bytewise ordering for IDs. Causally later events must have a greater logical time than events their author has observed. Equal logical times represent concurrent events; the device and event IDs make replay order stable, but do not themselves resolve semantic conflicts. Conflict policy is planned for v0.0.5.

Wall clocks can drift, collide, or move backward, so timestamps are never the distributed ordering authority. This ordering direction is a requirement to validate during the protocol design, not a claim that sync exists in v0.1.0.

## Idempotency and invalid events

- Re-delivery of an identical `event_id` and identical canonical event is ignored; replaying it has no additional effect.
- Reuse of an `event_id` with different content is invalid and fails reconstruction deterministically.
- A distinct `ITEM_COMPLETED` for an already-completed known item is a valid state no-op; both valid facts remain in history. This makes completion robust to repeated user intent without rewriting prior events.
- `ITEM_COMPLETED`, `ITEM_REOPENED`, or `ITEM_ARCHIVED` for an unknown item is invalid.
- `ITEM_REOPENED` on an active item is a valid state no-op; archival is terminal and every ordinary mutation of an archived item is invalid.
- Duplicate `ITEM_ADDED` for an existing item ID is invalid unless it is the exact same event already deduplicated by event ID.
- Malformed payloads, impossible field values, cross-household events, and unsupported event schema versions are invalid.
- An unknown event kind is not silently skipped. A client that cannot interpret an event must stop reconstruction with a deterministic unsupported-event error and preserve stored bytes for recovery by compatible software.

Event schema evolution must not rewrite history merely because the current internal model changes. Use explicit supported-version decoders and preserve canonical source bytes; unsupported newer events fail closed without destructive reinterpretation. Migration and forward-compatibility rules are detailed in [VERSIONING](VERSIONING.md) and [MIGRATIONS](MIGRATIONS.md).

Invalid input must not yield partially mutated visible state. The reducer returns an error for the failed stream; storage remains unchanged until an explicitly designed recovery action exists. See [State](STATE.md) for reconstruction semantics.

## v0.4.0 Talk

Stable schema-1 codes: 8 TALK_ADDED, 9 TALK_RESOLVED, 10 TALK_REOPENED, 11 TALK_ARCHIVED. Add payload is talk_id[16], text_length:u32, strict UTF-8 text (1–4096 bytes, nonblank). Lifecycle payloads are exactly talk_id[16]. Codes 1–7 and their canonical bytes are unchanged. Exact duplicate delivery is idempotent; conflicting event identity and duplicate Talk identity fail. See [V0.4.0](V0.4.0.md).

## v0.5.0 Pulse

Schema-1 codes 12 PULSE_SET (value:u8, reserved[7]=0, expires_at:i64; 16 bytes) and 13 PULSE_CLEARED (empty). Actor and set_at come from the envelope. Codes 1–11 unchanged; no expiry/acknowledgement event. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

No domain event kinds are added. Codes 1–13 and their persisted bytes remain unchanged. Summary entries are derived in Rust protocol v6 from existing Item, Handoff, and Talk events; Pulse remains excluded from entries while still contributing to the exact through-event boundary. Viewing or marking the local summary never appends a household event. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Schema-1 codes 14 ROUTINE_CREATED, 15 ROUTINE_OCCURRENCE_COMPLETED, 16 ROUTINE_OCCURRENCE_REOPENED, 17 ROUTINE_ARCHIVED. Creation persists text/cadence/creation civil date; occurrence actions persist a deterministic date key. No reset or automatically created occurrence event. Archive is terminal. The earlier conceptual ROUTINE_COMPLETED name never had a persisted wire code and is replaced by occurrence-specific naming. See [V0.7.0](V0.7.0.md).

## v0.9.x Distributed Canonical Events

Sync encrypts the exact canonical event bytes; it does not create a semantic JSON event record or rewrite pre-sync identity headers. New synchronized events embed authenticated household/member/device IDs. Historical local placeholder IDs are resolved by a separately signed, encrypted identity-binding control record, supplied to protocol v8 as verified context; source `canonical_bytes` remain exact. Event IDs remain stable 128-bit random identifiers and identify logical events independently of server cursors.

Protocols v1-v7 preserve their legacy strict increasing logical-time behavior. Protocol v8 accepts equal logical times and sorts a copy for state replay by `(logical_time, effective device_id bytewise, event_id bytewise)`. The decoded/input event array retains local arrival order for catch-up summary boundaries; transport cursor and UI acknowledgement cursor are separate. The local logical clock advances beyond the maximum observed event before authoring a causally later event.

Concurrent completion/reopen retains both facts and uses deterministic replay order for projection. Archive wins over an equal-Lamport concurrent mutation from another device; the losing mutation remains stored and is a state no-op. A mutation with greater logical time after the author observed archive is invalid and pauses replay. Duplicate delivery of identical event ID and bytes applies once; same ID with different bytes/envelope is corruption. See [V0.9.0](V0.9.0.md) and [ABI](ABI.md).
