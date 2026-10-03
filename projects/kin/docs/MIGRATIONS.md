# Data Migrations

**Status:** v0.11.7 implementation candidate adds a transactional SQLite service-schema migration alongside the existing recoverable local-encryption migration, root replacement and bounded verification. v0.9.3's additive local schema 1→2 migration remains supported as input; canonical bytes are not rewritten. Earlier version sections are historical.

## v0.11 server database migration

The Node service owns an independent `PRAGMA user_version` starting at schema
1. Migration 0→1 creates normalized identity, authorization, encrypted relay,
coordination and audit tables inside one SQLite transaction. Startup rejects
newer schema versions, inconsistent migration metadata and unversioned existing
tables; it never resets or downgrades the database. Tests inject an interruption
inside migration and verify rollback, then reopen successfully. See the
[v0.11 contract](V0.11.0.md) for the complete server schema and its relation to
product and client-storage versions.

## v0.9.3 → v0.10 local protection

Follow [V0.10.0](V0.10.0.md): establish/verify recovery and root wrappers first;
persist a stable journal; exclude stale writers; stage all events, context, outbox,
bindings and keys; decrypt/compare exact canonical bytes and perform complete Rust
replay; replace each database atomically; remove legacy plaintext and capabilities;
publish encrypted only after both databases agree. Key migration must include the
signed successor transition for nonextractable legacy transport private keys.

An interruption, tab closure, aborted transaction, quota error, key-generation
failure, cancelled authentication or failed ciphertext verification preserves the
legacy dataset or a verified replacement recoverable with the same wrappers.
Restart resumes the journal and never silently creates another root. Cross-DB
progress is recoverable, not one fictional atomic transaction. Schema upgrades
only establish structure; asynchronous crypto and network work happen outside them.

Implemented phases are absent/unconfigured, `preparing`, `cleanup-pending`, and
`encrypted`. Event DB 3 adds `security_state`; key DB 4 adds a protected staging
journal. Setup verifies an independent recovery wrapper before writing it. Web
Locks serializes migration; source snapshots and lock epochs are checked again
inside replacement transactions. Each staged value is decrypted and compared;
Rust replays the entire recovered canonical corpus. Legacy AES and sealed epoch
copies must agree (including fingerprint and authenticated test encryption)
before either is replaced. The root and signed successor remain stable on retry.
`cleanup-pending` cannot open a household; it resumes only key cleanup and final
commit. Quota, transaction abort, changed sources, cancelled unlock, corrupt keys
or lost capability fail without publishing a partial secure state.

New security metadata starts with `configRevision: 0` and `lockEpoch: 0`.
Compatibility reads treat an absent revision or epoch as zero. Wrapper updates
use a transactional revision comparison; removing an unlock wrapper increments
both the configuration revision and lock epoch atomically. This prevents a stale
tab from restoring a removed credential through a later wrapper write. Migration
replacement and final publication compare lock epochs again, so an interrupted
setup cannot overwrite a newer lock with its earlier journal snapshot.

## Migration categories

v0.10.3 retains canonical source bytes once and clones only metadata requiring
mutation. Every 32-row protection batch decrypts and compares exact values and
checks the durable security epoch before/after crypto. Legacy device migration
checks between individual device/epoch operations as well. Final source CAS uses
bounded native pages; full Rust replay still runs before atomic replacement.
Native key/event replacement transactions abort on lock through completion.

### v0.10.2 root replacement recovery

Root rotation is encryption re-protection, not canonical event migration. Before
event publication, original event/key rows remain intact and the journal retains
one candidate root through its verified recovery wrapper. The candidate encrypts
the old root for restart; old capabilities never wrap the candidate. Entering the
new recovery key resumes the same operation after tab closure/reload/process-style
restart. Every source/stage is compared exactly and full Rust replay repeats even
when the journal records prior verification.

After the atomic event/manifest switch, `root-cleanup` accepts only the candidate
recovery path and resumes idempotent key replacement and stage cleanup. Normal
household/sync access stays blocked until both databases agree. Quota/abort/peer
lock preserve either the original corpus plus the exact candidate journal or the
verified candidate corpus plus recoverable staged keys. No database schema bump,
canonical rewrite or household sync-epoch rotation is involved. The full versioned
contract is [ROOT-ROTATION](ROOT-ROTATION.md).

- **Storage migration:** change IndexedDB schema, such as database schema 1 to 2 (stores, indexes, local record layout). This is distinct from an event payload change.
- **Event/protocol migration:** decode a supported event or wire representation version into the current in-memory model. Persisted source event bytes remain immutable unless a separately reviewed, explicit export/restore conversion is required.
- **Projection migration:** change derived state, a disposable cache, or snapshot format. Rebuild from canonical events whenever possible; do not make a projection a second source of truth.
- **Export migration:** validate an older portable export format and import its logical events into the current event representation without silently dropping unsupported content.

Application, event, protocol, IndexedDB, and export versions are independent. Update only the version axis whose contract changed.

## Safety requirements

Once implementation begins, migrations must be deterministic for the same source bytes and target version, tested, and explicit about the data they read/write. They must not silently discard household events or meaningful fields. A destructive transformation requires exceptional justification, a reviewed recovery plan, and explicit user consent. Preserve original information when reasonably possible; rebuild derived state from events.

Storage changes should use an atomic IndexedDB upgrade transaction. Prepare a validated target representation before replacing source values; a failed transaction must leave the old database readable. Do not perform asynchronous network requests, cryptographic key changes, or unrelated work inside an upgrade transaction.

For an event format change, use a versioned decoder/normalizer that leaves original event bytes unchanged. v0.2.0 reads `ITEM_ADDED` schema v1 as Today and schema v2 with its explicit classification; it does not convert stored source bytes. If conversion of source bytes ever becomes unavoidable, first create and verify a portable backup, then stage the conversion separately and retain a recoverable original until successful validation.

## Failure behavior

```text
detect required migration
        |
        v
validate source and target support
        |
        v
attempt bounded, atomic migration
        |
    success? ---- no ----> abort transaction
        |                    preserve original data
       yes                   show recoverable error
        |                    offer export/restore path
        v
verify target records and replay
        |
        v
commit upgraded schema
```

A migration failure must never default to clearing IndexedDB, partially accepting the new schema, or presenting incomplete state as complete. Stop writes that could worsen the incompatibility. Preserve the database and surface a non-destructive recovery choice. If recovery cannot be guaranteed, explain that limitation rather than retrying destructive steps automatically.

## Backup before destructive changes

Before a migration that rewrites or removes user information, require a verified recovery representation that the user can store outside the current browser installation. The future portable format and its plaintext/encryption choices are described in [PORTABILITY](PORTABILITY.md). A backup is useful only if it can be read and its event stream validated; creating a file without a verification path is not a sufficient rollback plan.

## Test obligations

Migration implementations must have tests for supported old versions, malformed input, unknown newer versions, interrupted/aborted transaction behavior, preservation of original event bytes, deterministic output, successful replay after migration, and recovery from failure. No migration implementation is part of v0.1.0 beyond creating schema version 1 from an empty database.

## v0.5.0 Pulse

No migration is required. New Pulse events coexist with unchanged historical bytes in IndexedDB schema 1. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

No migration is required. Three optional fields are added to the existing `local_context` singleton, which is not a canonical household event. A context with all fields absent is initialized atomically with the current event tail; partial or malformed metadata fails closed and is not overwritten. IndexedDB schema remains version 1 and event bytes remain unchanged. See [V0.6.0](V0.6.0.md).
