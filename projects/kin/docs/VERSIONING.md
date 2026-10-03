# Persistent Contract Versioning

**Status:** v0.11.7 implementation candidate; awaiting human review. Earlier version sections preserve historical contracts.

## Independent version axes

Kin version numbers describe product releases; they do not version every persistent or transport contract.

| Version axis | Current published v0.10.3 / v0.11 candidate | Governs |
| --- | --- | --- |
| Application | Last published `0.10.3`; candidate `0.11.7` | Durable service/deployment; does not bump client or domain formats |
| Server database schema | `1` (`PRAGMA user_version`) | SQLite identity, authorization, opaque relay and coordination records |
| Canonical event schema | Item add 1/2; other kinds 1 | Immutable event interpretation; original bytes retained |
| Replay protocol | Reads v1–v8; writes local v7 / synchronized v8 | Request context and projection semantics |
| Manual WASM ABI | Existing exports plus additive command/metadata/archive/import APIs | Host ownership and calls; new command packet v1 |
| IndexedDB schema | Event DB 2→3; key DB 3→4 | Journalled upgrade to encrypted records |
| Local envelope | v1 for original roots; v2 for rotated roots | v2 authenticates rootVersion in addition to purpose/routing |
| Security manifest / rotation journal | Manifest v1/root 1; v2/root 2+; journal v1 | Monotonic root replacement, CAS and exact restart |
| Portable archive | KARC v1; metadata/body version 1 | Bounded encrypted archive and complete import planning |
| Sync envelope | v1 unchanged | Relay encryption/signature/provisioning contracts |
| Device-key successor | v1 with monotonic generation, maximum 16 transitions | Signed replacement of legacy transport capabilities |

These numbers evolve independently. An application release may keep the same event, protocol, storage, or export version; a contract may change between application versions. Never infer compatibility from equal version numbers or silently bump one axis as a proxy for another.

The v0.2.0 implementation reads event schema 1 for all supported kinds and schema 2 for `ITEM_ADDED`; new instances write add schema 2 and other Item event schema 1. v0.3.0 additionally reads Handoff schema 1, supports protocols 1/2/3, and writes protocol 3. IndexedDB schema remains 1. Export format version 1 is a future design baseline only.

## Compatibility policy

The table records implemented decoders and migrations, validated in [V0.10.0](V0.10.0.md). v0.10.1 preserves every v0.10.0 persistent format and requires no additional database migration.
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

Current compatibility: protocols 1/2/3/4; writer v4; Item add schemas 1/2, lifecycle and Handoff/Talk schema 1. IndexedDB schema 1. Legacy events retain exact source bytes. Protocols 1–3 reject Talk rather than omit it. See [V0.4.0](V0.4.0.md).

## v0.5.0 Pulse

Supported protocols 1/2/3/4/5; writer v5; Pulse kinds 12/13 schema 1; previous schemas unchanged. IndexedDB schema 1, no byte migration. Protocols 1–4 reject Pulse histories, even cleared histories. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

Supported protocols 1–6; current writer v6. Protocol v6 preserves explicit v5 `as_of` and adds the stable summary cursor/result; v1–v5 bytes and behavior remain unchanged. Event schema stays 1/2 for existing kinds, codes 1–13 remain unchanged, and IndexedDB remains schema 1 with no migration. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Supported protocols 1–7; current writer v7. New Routine kinds 14–17 use event schema 1. Old event kinds/schemas and bytes are unchanged; old protocols fail closed for Routine history. IndexedDB stays schema 1. See [V0.7.0](V0.7.0.md).

## v0.9.x Encrypted Sync

Protocol v8 is additive. It appends an authenticated target household ID and up to 256 fixed 96-byte legacy identity bindings to the v7 request header, followed by the same immutable 88-byte event records. v8 validates original canonical bytes, resolves effective identity for projection, sorts a copy for distributed state replay, and preserves original input/local-arrival order for catch-up boundaries. Protocols v1-v7 retain their original behavior. IndexedDB schema 2 adds sync state/outbox/binding stores; pre-sync event rows and bytes remain unchanged. Cryptographic envelopes, key wrapping, relay, migration, and historical entitlement are documented in [V0.9.0](V0.9.0.md).
