# Persistent Contract Versioning

**Status:** Application version 1.6.0 — Kin for Everyone,
released 2026-10-21 as `kin-v1.6.0` (the release before it was v1.5.0). Household
membership is bounded to 12 total participants (four Adults and eight Limited
Members); Temporary Members require expiry. Earlier version sections preserve
historical data contracts.

**v1.0:** the formats frozen for v1.0, what every v1.x release promises about
them, and the "start fresh" rule for v0.x data are in
[V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md). That document is the current
reference; a CI test keeps it in step with the code. The table below is
historical.

**v2.0.0 (the family hub, [ADR 0022](decisions/0022-family-hub.md)):** a
product milestone, not a format break. The major number marks what changes
for people (the Calendar with Today and This week reworked, the kitchen
display, the chore chart, the family album and fuller meal plans). Every
format change is additive: event kinds 71–82 (schema 1, replay protocol
still 24), new read exports beside the existing ones, server schema 29
(28 for the chore chart's adult setting, 29 for calendar subscriptions) with
forward migrations, new device databases `kin-album:<household>` and
`kin-calendar-feeds:<household>` beside the frozen event and key databases,
and household feature bits 14–17. KINS, the sync envelope, the key database
and export package formats are unchanged. Devices on v1.x pause household
sync on the new kinds ("update Kin") and keep their data. The rows are in
[V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md#additions-since-v10).

## Independent version axes

Kin version numbers describe product releases; they do not version every persistent or transport contract.

| Version axis | v1.6.0 | Governs |
| --- | --- | --- |
| Application | `1.6.0` | The product release; the service-worker cache name advances with the release |
| Server database schema | `28` (`PRAGMA user_version`; migrates 9→10→11→…→28, adding chat relay, content blobs, delete-for-me, receipts, access policy and the dedicated chat key in 12–17, the fridge relay and its access policy in 18–19, Simple view in 20, account vaults in 21, the private relay in 22, usernames in 23, private blobs in 24, household features in 25, reports to the team in 26, prepared invitations in 27 and the chore chart's adult setting in 28) | SQLite identity, authorization, recorded founder/admin authority, opaque relay, coordination, lifecycle, encrypted settings/attachment records and their uploaders, member kind, Temporary expiry, authoritative membership status, installed-app identity, and push subscriptions |
| Canonical event schema | Item add 1/2; other kinds 1 | Immutable event interpretation; original bytes retained |
| Replay protocol | Reads v1–v24; writes v24 for local and synchronized requests | Request context and projection semantics |
| Manual WASM ABI | Existing exports plus additive command/metadata/archive/import APIs | Host ownership and calls; new command packet v1 |
| IndexedDB schema | Event DB 2→4; key DB 3→4 | Journalled upgrade to encrypted records; protected attachment rows |
| Local envelope | v1 for original roots; v2 for rotated roots | v2 authenticates rootVersion in addition to purpose/routing |
| Security manifest / rotation journal | Manifest v1/root 1; v2/root 2+; journal v1 | Monotonic root replacement, CAS and exact restart |
| Portable archive | KARC v1; writes body format 3, reads 2 and 3 | Bounded encrypted archive; format 2 added protected attachments and format 3 streams bounded segments |
| Sync envelope | v1 unchanged | Relay encryption/signature/provisioning contracts; Note plaintext remains only in encrypted event content |
| Device-key successor | v1 with monotonic generation, maximum 16 transitions | Signed replacement of legacy transport capabilities |

These numbers evolve independently. An application release may keep the same event, protocol, storage, or export version; a contract may change between application versions. Never infer compatibility from equal version numbers or silently bump one axis as a proxy for another.

The v0.2.0 implementation reads event schema 1 for all supported kinds and schema 2 for `ITEM_ADDED`; new instances write add schema 2 and other Item event schema 1. v0.3.0 additionally reads Handoff schema 1, supports protocols 1/2/3, and writes protocol 3. IndexedDB schema remains 1. The v0.23.0 `.ics` output uses iCalendar 2.0 independently of Kin's encrypted KARC archive format; it does not change either persistent contract. v0.24.0 protocol 17 appends an Item's derived latest-effective-event timestamp after its planning date; it stores no separate history value.

## Compatibility policy

The table records implemented decoders and migrations, validated in [V0.10.0](planning/V0.10.0.md). v0.10.1 preserves every v0.10.0 persistent format and requires no additional database migration.
v0.10.2 keeps event/key DB versions 3/4 and stores versioned staging values in
existing security stores. An unrotated root remains readable by v0.10.0/0.10.1;
after explicit rotation those clients fail closed on manifest/local-envelope v2.
KARC v1 framing, crypto and body remain supported, including old root-v1 archives.
Archives made after rotation carry manifest v2 and require a reader supporting it.
An additive ABI or storage change does not rewrite canonical history or imply a
sync-protocol bump. v0.10.3 adds compact archive-framing ABI calls while retaining
the original exports and all v0.10.2 persistent formats. v0.9 clients cannot open the upgraded local databases or unlock
the protected records. Mixed old/new sync clients preserve relay-envelope format,
but an old client cannot validate a new signed device-key successor and must be
upgraded before trusting changed fingerprints. Do not downgrade persisted stores.

Newer Kin versions should read older supported household data whenever reasonably possible. Each release must declare which event, protocol, storage, and export versions it can read and write. A version is supported only when a tested decoder/migration exists; compatibility must not be assumed from a version number alone.

- **Known supported version:** decode, validate, and process according to its documented semantics.
- **Known older version with an explicit upgrader:** preserve the original record, normalize it to the current in-memory representation, and make migration atomic/recoverable.
- **Unknown or unsupported older version:** stop before modifying source data; offer a recoverable compatibility error and export/restore path where possible.
- **Unknown newer version:** do not reinterpret, skip, rewrite, or delete it. Preserve its raw bytes if possible, stop operations that would risk loss, and explain that a newer compatible Kin version is needed.

“Unsupported” means Kin cannot establish the meaning and integrity of the data safely. It does not mean invalid, disposable, or safe to delete. In a mixed-version future sync, an older client must not write a replacement snapshot that omits unknown newer events.

## Event evolution

Persisted events are immutable. A change to today's domain model does not by itself justify rewriting historical event bytes. Prefer a version-specific decoder/upgrader:

```text
immutable Event v1 bytes
          |
          v
v1 decoder and validation
          |
          v
current internal event representation
          |
          v
current reducer/projection
```

This separates durable history from evolving in-memory types and enables old history to be replayed. It has costs: old decoders remain maintenance obligations, normalization rules need tests, and an unsafe upgrader can still lose meaning. Only add an upgrader when a supported release requires it; retain original bytes and record its version/behavior.

## Backward and forward guarantees (through v0.9; v0.10 storage table above)

Kin has published v0.1.x event history. v0.2.0 explicitly reads schema-v1 legacy item events, normalizes them in memory, and preserves their exact bytes; it writes schema-v2 `ITEM_ADDED` and schema-v1 lifecycle events. Protocols v1-v8 are supported. Local-only clients continue to write v7; synchronized clients use v8 for verified identity mappings and distributed replay. Protocols v1/v2 reject Handoff history rather than return lossy state. IndexedDB schema 2 adds only sync stores/context metadata; existing event rows and bytes are unchanged. A client with no decoder for a future event must preserve it and fail closed, not pretend it has derived complete household state.

## v0.4.0 Talk

Current compatibility: protocols 1/2/3/4; writer v4; Item add schemas 1/2, lifecycle and Handoff/Talk schema 1. IndexedDB schema 1. Legacy events retain exact source bytes. Protocols 1–3 reject Talk rather than omit it. See [V0.4.0](planning/V0.4.0.md).

## v0.5.0 Pulse

Supported protocols 1/2/3/4/5; writer v5; Pulse kinds 12/13 schema 1; previous schemas unchanged. IndexedDB schema 1, no byte migration. Protocols 1–4 reject Pulse histories, even cleared histories. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

Supported protocols 1–6; current writer v6. Protocol v6 preserves explicit v5 `as_of` and adds the stable summary cursor/result; v1–v5 bytes and behavior remain unchanged. Event schema stays 1/2 for existing kinds, codes 1–13 remain unchanged, and IndexedDB remains schema 1 with no migration. See [V0.6.0](planning/V0.6.0.md).

## v0.7.0 Routines

Supported protocols 1–7; current writer v7. New Routine kinds 14–17 use event schema 1. Old event kinds/schemas and bytes are unchanged; old protocols fail closed for Routine history. IndexedDB stays schema 1. See [V0.7.0](planning/V0.7.0.md).

## v0.16.0 Notes

Protocol 10 is additive and uses the unchanged 64-byte request header and 88-byte
event envelope. New schema-1 event kinds 22–24 represent Note create, update,
and terminal archive. The protocol-10 result appends a Note count and bounded
Note records after the protocol-9 Areas section. Protocols 1–9 retain their
historical request and result bytes and reject Note history rather than omit it.
Pre-Note histories replay to an empty Notes collection without migration.
IndexedDB, event schema, KARC framing, and encrypted sync envelope stay
unchanged.

## v0.16.1 Notes correctness

Protocol 10 and all persistent formats remain unchanged. Distributed replay
pre-scans Note archive events and ignores a same-logical-time update from a
different device regardless of deterministic device-ID ordering; the terminal
archive wins and projection converges. Browser preflight matches Rust's
Unicode scalar, UTF-8 byte, and control-character limits. The service worker
cache version advances to invalidate its static shell and includes the Notes
component.

## v0.17.0 Checklist Steps

Protocol 11 is additive. It preserves the 64-byte request header and 88-byte
event envelope, adds schema-1 event kinds 25–28, and appends a Step count and
bounded Step records after Notes in the result. Protocols 1–10 retain their
request/result layouts and reject Step events. Existing histories project no
Steps without migration; IndexedDB, server schema, KARC v1, and sync-envelope
versions remain unchanged. The service-worker static cache version advances
for the new client release; `item` was already in the component shell.

## v0.18.0 Richer Routine Scheduling

Protocol 12 is additive. It preserves the protocol-11 request and result
layouts and canonical event payloads. Routine cadence values 2 and 3 represent
creation-date-anchored every-two-weeks and calendar-month periods; protocols
1–11 reject these values and cannot encode state containing them. Protocol 12
replays existing Daily/Weekly histories unchanged. No event schema, IndexedDB,
server, KARC, or sync-envelope migration is required.

## Daily UX: Repeating tasks (protocol 24)

Protocol 24 is additive and carries no application version change. Routine
cadence value 4 represents Weekdays (one occurrence per Monday–Friday civil
date); the result appends one derived next-occurrence date per Routine. Request
and result headers, existing sections, canonical event payload layouts,
IndexedDB, KARC, server schema and the sync envelope are unchanged. Protocols
1–23 reject Weekdays events and state rather than project them; a device
running an older build fails closed on a synchronized Weekdays task until it
is updated, as with protocol 12.

## v0.19.0 Shared Shopping Lists

Protocol 13 extends the existing schema-v2 `ITEM_ADDED` classification byte
with code 2 for Shopping; it adds no event kind and changes no payload layout.
Protocol 13 reads prior histories and writes its compatible result layout.
Protocols 1–12 reject Shopping-bearing events, summaries, or projections,
while their Today/Needs-only behavior and bytes remain unchanged. IndexedDB,
server schema, KARC v1, and encrypted sync envelope remain unchanged. Existing
canonical events carry Shopping through local persistence, sync, and
archive/import without a data migration.

## v0.20.0 Staples & Replenishment

Protocol 14 extends the existing schema-v2 `ITEM_ADDED` classification byte
with code 3 for reusable Staples; codes 0–2 retain Today, Needs, and Shopping.
It adds no event kind and changes no payload layout. Protocols 1–13 reject
Staple-bearing events, summaries, or projections; protocol 13 continues to
support Shopping. IndexedDB, server schema, KARC v1, and encrypted sync
envelope remain unchanged. Replenishment is a user-triggered append of an
independent Shopping Item and requires no data migration.

## v0.21.0 Household Modes

Protocol 15 adds schema-1 canonical event kind 29, with a one-byte closed
mode value, and appends a four-byte mode/reserved field to the result header.
Protocols 1–14 reject mode events and non-Normal projections. Histories
without a mode event default to Normal without rewriting canonical bytes.
IndexedDB, server schema, KARC v1, and encrypted sync envelope remain
unchanged; older protocol serialization fails closed rather than dropping
mode state.

## v0.22.0 Lightweight Planning Dates

Application v0.22.0 adds schema-1 event kind 30 and replay protocol 16.
Protocol 16 appends an optional `u32` planning date for each Item after the
existing Step records. Protocols 1–15 retain their historical layouts and
fail closed on the new event or dated projection. Existing canonical event
bytes, IndexedDB schema, KARC v1, and encrypted sync envelope are unchanged.

Application v0.24.0 adds replay protocol 17, which appends one derived
little-endian `i64` event timestamp per Item after the protocol-16 planning
dates. It represents the latest effective Item or checklist-Step event in
deterministic replay order. Protocols 1–16 retain their historical layouts;
there is no new canonical event or persistent migration.

## v0.9.x Encrypted Sync

Protocol v8 is additive. It appends an authenticated target household ID and up to 256 fixed 96-byte legacy identity bindings to the v7 request header, followed by the same immutable 88-byte event records. v8 validates original canonical bytes, resolves effective identity for projection, sorts a copy for distributed state replay, and preserves original input/local-arrival order for catch-up boundaries. Protocols v1-v7 retain their original behavior. IndexedDB schema 2 adds sync state/outbox/binding stores; pre-sync event rows and bytes remain unchanged. Cryptographic envelopes, key wrapping, relay, migration, and historical entitlement are documented in [V0.9.0](planning/V0.9.0.md).
