# Data Migrations

**Status:** Single baseline (refactor track, Slice 2). Kin has never shipped to real users. Owner decision D3 made protocol 24 the only wire format: protocols 1–23, the schema-1 `ITEM_ADDED` payload, archive package format 1 and the v0.5→v0.6 catch-up-context backfill were deleted, and development databases are wiped rather than migrated. Release notes under `docs/releases/` and the `V0.*.md` contracts keep the history of the removed formats.

## The baseline

| Contract | Current version | Older versions |
| --- | --- | --- |
| Replay protocol (KINE/KINS) | 24 | Rejected with status 3 |
| Canonical events | `ITEM_ADDED` schema 2; every other kind schema 1 | Schema-1 `ITEM_ADDED` rejected with status 3 |
| Command transport (KCMD), metadata (KMET, KMDQ/KMDL), command result (KCMT), import plan (KIMP) | 1 | None existed |
| Error buffer (KERR) | 1 | None existed |
| Archive container (KARC) | 1 | None existed |
| Archive package | 2 | Package 1 refused |
| Event IndexedDB `kin` | schema 5 | Structures are created on first open |
| Key IndexedDB `kin-crypto-keys` | schema 5 | Structures are created on first open |
| Local envelope / root manifest | Format 1 roots, format 2 after rotation | Both current |
| Server SQLite | `user_version` 11 (9 at v1.0) | Upgrade chain 0→11 retained (see below); 10 adds the published install identity tables and 11 the push notification tables (v1.1) |

Application, event, protocol, IndexedDB, archive and server versions remain
independent; change only the axis whose contract changes.

## What is still a migration

Three mechanisms keep their migration-style code because they are part of the
current product, not compatibility with old data:

- **Local protection setup.** `EventStore.migrate` (phases `preparing`,
  `cleanup-pending`, `encrypted`) is how a new household's plaintext setup
  becomes encrypted storage. It stages, verifies and replaces every store and
  is described in [V0.10.0](planning/V0.10.0.md). Removing it would change security
  setup, which no refactor slice authorizes.
- **Sync key preparation.** `migrateSyncKeys` / `finalizeSyncKeyMigration` run
  inside that setup and inside root rotation.
- **Identity bindings.** A household created locally keeps its placeholder
  household/actor/device IDs in canonical bytes forever. When it enables sync,
  a signed binding maps that tuple to the authenticated identity on every
  replay ([IDENTITY](IDENTITY.md), [SYNC](SYNC.md)). The binding fields
  (`legacyHouseholdId`, `legacyActorId`, `legacyDeviceId`) are therefore
  load-bearing and stay.

Root rotation ([ROOT-ROTATION](ROOT-ROTATION.md)) is re-encryption, not a
format migration, and is unchanged.

The server's SQLite upgrade chain (0→11) is also retained for now. Schema 8's
admin promotion is an authority-bearing step, and the server split belongs to
Slice 10; removing the chain there would need its own review.

## Rules for any future change

- Canonical event bytes are immutable history. A new capability adds an event
  kind or a projection field; it never rewrites stored events.
- Before Kin has real users, a breaking wire change may replace the format
  outright (D3). After that, it needs a versioned decoder, a portable-backup
  path and explicit consent before anything is rewritten.
- Storage changes use one atomic IndexedDB upgrade transaction and never clear
  data as a fallback. Crypto, network and other asynchronous work never runs
  inside an upgrade transaction.
- A failure preserves the original data and surfaces a recoverable message; it
  never presents incomplete state as complete.
- Every change updates the golden fixtures deliberately
  ([TEST-VECTORS](TEST-VECTORS.md)) and records the version axis that moved.

## Projection caches

The session event arena and any future checkpoint are derived projections,
not migrations: they are rebuilt from canonical events whenever their store
generation or row count disagrees with storage ([STORAGE](STORAGE.md)).
