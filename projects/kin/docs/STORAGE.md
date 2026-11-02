# Local Event Storage

**Status:** v0.10.3 encrypted local storage. The event database is schema 3, key database schema 4, local envelopes v1 (original roots) and v2 (rotated roots). Canonical event bytes remain unchanged inside authenticated ciphertext. The v0.9.3 database description and earlier notes below record the migration source.

All four household draft surfaces now retain text only in unlocked inputs. Reload/lock discards drafts, and startup removes historical sessionStorage draft keys before components mount. No household plaintext is written to localStorage, sessionStorage, Cache Storage, cookies, OPFS or debug persistence.

localStorage holds per-device preferences only (such as the inactivity lock,
`kin.auto-lock-minutes`). Since #563 that includes the name of the password-manager
entry this device saved its backup key under with that key's label
(`kin.backup-key-entry`: up to three, newest first, e.g.
`[{"label":"K-7F3A","name":"Kin backup key — Chrome on Android (K-7F3A)"}]`;
never the key, never a nickname) and whether
the passkey suggestion was dismissed (`kin.passkey-suggestion-dismissed`).
Losing them only changes which entry the unlock form asks for and whether the
suggestion shows.

## Session event arena (refactor track)

An unlocked `EventStore` keeps the decrypted canonical history in memory
(`web/storage/event-arena.js`) instead of re-reading and re-decrypting every
row for each command and refresh. The arena is one growable byte buffer of
exact `encoded_event` bytes plus typed-array indexes (offset/length,
`local_sequence`, logical time, timestamp, the four 16-byte identifiers, kind
and schema version, and an event-ID hash table). `records()` returns subarray
views; replay requests copy the contiguous bytes in one operation.

It is a derived cache, never a second source of truth:

- **Order.** Records are kept in ascending `local_sequence`, which is exactly
  the order `getAll()` returns. `local_sequence` is the `events` store's
  auto-increment key, so it is monotonic in insertion order: local appends use
  `events.add`, and synchronized events are appended after the tail with their
  expected key asserted (`commitRemoteBatch`), even when they sort earlier in
  logical time. The engine's v8+ reducer sorts its own copy by
  `(logical_time, device_id, event_id)` but uses input order for catch-up
  boundaries, so the arena must preserve local order. It does; no new
  insertion-order index is needed.
- **Reading.** Each event transaction reads the persisted store generation and
  the row count in the same native transaction. With a matching generation it
  decrypts only rows after the arena tail
  (`IDBKeyRange.lowerBound(tail, true)`, still paged at 128 rows); any count or
  generation mismatch rebuilds from every row. Unlock is the first full read.
  Rows are validated (Rust metadata against routing fields) when they enter the
  arena; decrypted row copies are zeroed once copied in.
- **Local writes.** After a local or synchronized append commits, the arena is
  extended with the plaintext the transaction already held, only if it is the
  direct successor of the history the write validated against.
- **Generation.** `security_state` holds a plaintext
  `{ key: "event_generation", generation }` record (absent means 0). Every
  non-append change to the `events` store increments it in the same
  transaction: migration publication, restore into an empty household and root
  rotation's corpus replacement. Kin has no event deletion or compaction today
  ([RETENTION](RETENTION.md)); a future retention path must bump it too. The
  counter reveals only that the corpus was replaced, not its content.
- **Lifetime.** `close()` and any vault lock (local, peer-tab or durable-epoch
  mismatch) zero-fill every arena buffer and drop it. Growth zero-fills the
  buffers it replaces.

The v0.5→v0.6 backfill that initialized missing catch-up cursor fields was
removed with the protocol reset (Slice 2, D3): a context without all three
fields now fails closed like a partial one. Archive restore accepts only
package format 2 with `formatVersion: 2` snapshots.

Projection equivalence is enforced by `scripts/event-arena-regression.mjs`:
the cached path must produce byte-identical protocol-24 projection bytes to a
fresh full read and full replay with the same `as_of`, civil date, cursor and
identity, across unlock, local and cross-connection appends, out-of-order
sync, a generation-detected rewrite (with a negative control), restore,
rotation and lock.

## Database

### v0.10.2 root replacement

Event DB 3 and key DB 4 retain their structures. Their existing `security_state`
key/value stores hold versioned per-record rotation stages. The authoritative
event singleton follows `encrypted` → `root-rotating` → `root-cleanup` →
`encrypted`. Its version-1 journal binds one random rotation ID, vault identity,
source/target root versions, source/candidate manifests and a candidate-protected
source-root bridge. Progress checkpoints are durable; resume repeats verification.
No source store is replaced before all event/key stages pass verification.

The first CAS advances the lock epoch and fences normal event access; the key
database also fences transactions before its source snapshot. Normal transactions
compare root version as well as phase/vault/epoch. Wrapper updates retain revision
CAS. Event replacement and the new manifest commit together; key replacement is
idempotent and journalled, then final publication enables ordinary access. Locked
or interrupted work cannot publish stale results. See [ROOT-ROTATION](ROOT-ROTATION.md).

## v0.10 encrypted storage contract

v0.10.3 pages large protected reads in 128-row native requests and bounds crypto
concurrency to 32. The enclosing transaction preserves the original snapshot and
serialized-write semantics. Local capability cancellation is checked between
batches; prompt numbered peer-lock intent aborts long reads before the durable
epoch write queues behind them. If notification is missed, the current read
serializes before the epoch commit and every subsequent stale operation fails.
Do not open an external epoch-read transaction from inside an event read that
already holds the security store: a queued lock write could deadlock it.

Migration retains one immutable canonical source, clones only metadata requiring
mutation, decrypts/compares each replacement, and fully replays the verified
canonical bytes. Final source comparisons use bounded pages. Restore's private
authenticated snapshot can explicitly transfer ownership; public caller snapshots
retain defensive copying. Final native migration/restore/rotation transactions
abort on local lock. Complete plaintext results remain required at the bounded
10,000-event/64 MiB Rust replay and KARC v1 interfaces.

The [v0.10 contract](planning/V0.10.0.md) defines the complete baseline inventory, minimal
routing metadata, AES-GCM envelope/AAD, key hierarchy and transaction requirements.
All event values, duplicate canonical outbox values, protected context and sync
metadata require encryption. The schema version, envelope version and event
protocol version remain independent. Canonical bytes remain authoritative and
unchanged inside ciphertext; routing indexes must match authenticated content.

Reads are unavailable without a live unlock capability. Writes must abort if that
capability is revoked while Web Crypto is pending. Preserve serialized native
IndexedDB transactions through explicit keepalive tracking; never await crypto
without keeping the transaction active. Authentication failure aborts the whole
operation. Unlocked plaintext is ephemeral. v0.10 removes household draft text
from sessionStorage; lock clears drafts and projected content in all live tabs.

Current protected stores retain only their key-path/index routing fields plus
`protected_version: 1` and `protected_value`. The latter carries local-envelope
version, vault ID, 32-byte salt, 12-byte nonce and ciphertext/tag (base64url).
Everything else in the value is encrypted. The public `security_state` singleton
holds format/root version, vault ID, recovery/PRF wrappers, verifier, migration
phase, monotonic `lockEpoch`, and wrapper `configRevision`; no usable secret is stored there. A durable epoch
check inside each event transaction prevents missed peer notifications from
allowing stale reads or writes. Key operations and network requests also check the
epoch. Lock aborts in-flight crypto/transactions and rejects stale adapters.

Wrapper changes compare the caller's `configRevision` with the current singleton
inside one write transaction. Successful changes increment that revision; removing
a wrapper also increments `lockEpoch` in the same commit. A stale tab cannot
overwrite newer wrappers or restore a removed unlock path. A failed candidate is
discarded in favor of committed metadata, or its capability is locked when the
configuration has changed. Adding a wrapper leaves event ciphertext unchanged.

The key database stores encrypted private-key serializations and sealed epochs;
runtime imported private/AES keys are nonextractable and never structured-cloned
into persistent storage. A cross-database migration journal protects staged keys
until verified event replacement and final key cleanup succeed. Migration requires
Web Locks; an unsupported browser fails explicitly without deleting legacy data.

The remaining schema description records the v0.9.3 migration source.

## v0.9.3 database

```text
database: kin
version: 2

object store: events
  keyPath: local_sequence
  autoIncrement: true
  unique index: event_id

object store: local_context
  keyPath: key
  singleton: key = "installation"
    fields: household_id, actor_id, device_id, next_logical_time,
      last_looked_event_id, last_looked_local_sequence, last_looked_at,
      sync_household_id, sync_member_id, sync_device_id,
      sync_identity_bindings

object store: sync_state
  keyPath: key
  singleton: key = "active"

object store: sync_outbox
  keyPath: event_id

object store: sync_bindings
  keyPath: legacy_key
```

Use one object store for the ordered domain event history and one singleton context record for local IDs and the next logical-time counter. Those values are generated locally and do not represent accounts, verified members, or trusted devices. Do not store a second authoritative mutable household state.

## Event record

Each `events` record contains:

```text
local_sequence       IndexedDB-generated integer; local append/replay order
event_id             16-byte stable event identifier; unique index
household_id         16-byte local placeholder before sync; authenticated household afterward
actor_id              16-byte local placeholder before sync; authenticated member afterward
device_id             16-byte local placeholder before sync; authenticated device afterward
timestamp            signed UTC epoch milliseconds
logical_time         unsigned 64-bit local logical order value
kind                 Item 1–4, Handoff 5–7, Talk 8–11, Pulse 12–13 (see ABI)
event_version        ITEM_ADDED schema 1 or 2; all other supported kinds schema 1
encoded_event        exact canonical event bytes used for Rust replay
```

The IndexedDB `local_sequence` orders this installation's events and is not a cross-device identity. `next_logical_time` starts at 1 and advances by one in the same transaction as each accepted event. Event IDs are generated independently using a browser cryptographic random source and do not derive from the auto-increment key. `encoded_event` preserves the exact validated event envelope/payload; its layout is defined in [ABI](ABI.md).

`encoded_event` is the canonical record. The other fields are lookup/order metadata decoded from that envelope; the write transaction must keep them consistent. A mismatch on read is an integrity error and must not be silently resolved in favor of either representation. Existing v0.1.x schema-v1 add records remain unchanged and normalize to Today during Rust replay.

Sync never rewrites pre-sync `encoded_event` bytes or regenerates history from projection. A signed/encrypted identity-binding control record maps a legacy placeholder tuple for in-memory v8 interpretation. New events encode authenticated household/member/device IDs. The schema-2 migration creates only sync stores/context fields; existing event rows and catch-up fields remain intact.

## Append and read behavior

- Open the database and complete schema creation/migration before displaying a usable state; surface a clear failure if storage cannot open.
- Read all records for the current local household in ascending `local_sequence`, preserving the exact encoded event bytes.
- For each command, open one read/write transaction over both stores. Read the current full event stream and the local context/counter; when both requests complete, synchronously create the candidate event using `next_logical_time` and call Rust with the current stream plus candidate. If Rust rejects it, abort without writing. If accepted, append the canonical event record and increment `next_logical_time` in the same transaction. Do not await unrelated asynchronous work inside the transaction.
- IndexedDB serializes overlapping read/write transactions across tabs. Re-reading the stream inside the transaction prevents a stale tab from validating against an obsolete event list. `local_sequence` is generated by `events.add`; both it and the logical time follow serialized transaction order. The counter update and event insertion commit or abort together. Render the returned candidate projection only after transaction completion.
- After a successful append, tabs notify same-origin peers over `BroadcastChannel` with only an `events-changed` invalidation marker. A receiving tab reloads canonical event bytes and asks Rust to rebuild state; household text, event payloads, and projections are never sent in the message. Browsers without `BroadcastChannel` keep storage correct but an idle peer view may remain stale until reload or its next local action.
- The current prototype supports at most 10,000 stored events and a 64 MiB replay request. At the limit, reject new changes with a clear message and preserve the event log; later releases may revise this bound with a deliberate replay/storage design.
- The event becomes locally accepted only after transaction completion. Quota failures abort the transaction, keep the compose draft, and offer a retry action; the prior event history remains unchanged.
- The unique `event_id` index prevents local duplicate insertion. If an append reports an existing ID, compare canonical bytes: identical delivery is a no-op; different content is an integrity error.
- Keep the event history intact when an item is completed, reopened, or archived. The item state is reconstructed by passing the ordered events through Rust.
- A failed Rust replay never mutates IndexedDB or exposes partial derived state.

## Source of truth

IndexedDB stores events. Rust derives household state from those events. Do not persist current mutable Items as another authoritative record. A future disposable cache is outside v0.1.0 and must be rebuildable from events.

## Migration and deletion

Increment the IndexedDB schema version only for structural database changes. Each migration must be transactional, preserve event bytes and ordering where possible, and fail with a recoverable message rather than silently discarding data. Event schema version, ABI protocol version, application version, and portable export version are independent from the IndexedDB database version. On an unsupported version or failed upgrade, preserve the existing database and do not clear it as a fallback. See [VERSIONING](VERSIONING.md) and [MIGRATIONS](MIGRATIONS.md) for compatibility and recovery policy.

Archive is an Item, Handoff or Talk tombstone event; it does not delete source events or implement physical deletion. Portable copy, household deletion, remote deletion, backup retention, and event compaction remain future work described in [RETENTION](RETENTION.md) and [PORTABILITY](PORTABILITY.md). Do not silently delete history as a side effect of completing or archiving an item.

## Chat content blobs (v1.1, #110)

Chat message content is stored apart from the event store, so deleting a
message can delete its content without touching the immutable log or the
frozen event database schema. Each household has its own database,
`kin-chat-blobs:<householdId>`, version 1 (`web/chat/chat-blob-store.js`):

- `blobs`: `{ ref, ciphertext, storedAt, parts }`, sealed content by the
  SHA-256 of its bytes ([SYNC](SYNC.md#chat-content-blobs-v11-110)). `parts`
  is set on an attachment's manifest only: the references of its parts and
  thumbnails, so deleting the manifest deletes them too, and so that the
  outbox uploads them first ([SYNC](SYNC.md#photos-and-files-v11-114)). No
  index changes: the database is still version 1. Blobs are already
  ciphertext and their keys live only in the encrypted chat events, so the
  store holds nothing readable on its own; it is not wrapped in the
  encrypted record format.
- `retired`: `{ ref, retiredAt }`, blobs this device deleted. A retired blob
  is never stored or fetched again; its message shows as deleted.

A blob is fetched when its message is first shown and kept afterwards; a
blob from the service is checked against its reference before it is kept.
Deleting a blob removes its bytes and adds its tombstone in one transaction.
`ChatBlobStore.destroy()` deletes the whole database; a tab holding it open
closes its connection when asked, and an old tab that doesn't blocks the
deletion with a "close other tabs" error. Calling it when the household
leaves the device is still to come; today local household data stays on the
device as before.

**Cache trim (#125).** A device keeps chat content (downloaded or sent from it) for 90 days
(`CHAT_CACHE_DAYS`). During a sync pass (after pulling), at most every six hours,
`ChatBlobStore.evictOlderThan` drops the bytes of blobs stored longer ago,
except those of the outbox and the parts of their attachment manifests. It
writes no `retired` row: the message stays, and opening it fetches the blob
from the service again. It reads the blob rows in one `getAll`, so a pass
briefly holds at most the cache in memory (bounded by the household's
256 MiB blob quota).

## Chat log (v1.1, #111)

The chat log is kept apart from the frozen event database, in its own
database per household, `kin-chat-log:<householdId>`, version 1
(`web/chat/chat-log-store.js`):

- `events`: `{ order, eventId, envelope }`, every chat event as the signed,
  encrypted envelope it travelled in, keyed by the order this device stored
  it. Envelopes are encrypted under a household key epoch held in the key
  database, so the log needs no sealing of its own and root rotation doesn't
  touch it. Signatures are checked once, when an event arrives; reopening the
  log only decrypts.
  A restored export (#136) stores each chat event as `{ order, eventId,
  imported }` instead: the canonical event sealed by the local vault (store
  `chat-import`, the event ID as its context), because there is no relay
  envelope to check until the device is approved. These rows follow the vault:
  a recovery key replacement leaves them unreadable (chat opens without
  them) until the export is restored again, which seals them afresh in place.
  An event the relay already gave the device is never replaced.
- `ids`: `{ eventId, order }`, so each event is stored once even when two
  tabs store it together.
- `outbox`: `{ deviceSequence, eventId, blobRef, retireRef, retireParts }`, this device's
  events the relay hasn't accepted, the blob each uploads first and the blob
  it replaced. A message in the outbox shows as waiting to send.
  `retireParts` lists the parts of an attachment the event deletes (#114).
- `meta`: `{ key: "state", nextOrder, cursor, deviceSequence, provisional,
  admins, members, membersSignature, retiredThrough, refused, hidden,
  hiddenRevision, hiddenDirty, hiddenSealedFor, read }`: the relay
  position read up to, this device's last chat sequence
  ([SYNC](SYNC.md#chat-relay-v11-111)), the household admins last seen and
  the household's member list (ID, kind, active, in the service's order, with
  the directory state it was fetched for) so removals and author labels show
  offline, how many events'
  replaced blobs were already deleted here, and the last 100 relay events
  skipped because they failed authentication; and `hidden`, `hiddenRevision`,
  `hiddenDirty` and `hiddenSealedFor`: the messages this member deleted for
  themselves, the record revision last read or written (a lower one served
  later is written over with what the device holds), whether one hidden here still has to be written, and
  the devices the record was last sealed to
  ([SYNC](SYNC.md#delete-for-me-v11-119)); `read`: this member's private
  read position, `{ postedAt, messageId }`, for the unread count
  ([SYNC](SYNC.md#unread-position-v11-133)); and `presence`: this member's
  read cursor, their receipt and typing settings, and the revision of their
  receipt slot on the service
  ([SYNC](SYNC.md#read-receipts-and-typing-v11-120)); and `access`: the chat
  access level the service last gave this member, `write`, `read` or `none`
  ([SYNC](SYNC.md#chat-access-policy-v11-123)).

Chat keys (#123) are not in the chat log: they are household-key-style epochs
in the device key store under the family `chat:<household>`, sealed to the
device like the household keys, so root rotation re-seals them
([SYNC](SYNC.md#dedicated-chat-key-v11-123)). On the service, `chat_key_packages`
holds one wrapped package per device and chat key epoch, and
`households.chat_key_epoch` the current epoch.

While Kin is unlocked the decrypted log is held in memory as one growing
buffer (`web/chat/chat-records.js`) that the engine's chat log mirrors
incrementally; locking zeroes and drops it. Opening reads and decrypts the
log in chunks of 500, alongside the first household sync rather than before
it, and reads of newly stored events run one at a time per tab. Sending and
renumbering take a Web Lock per household, and the store writes that add or
renumber pending events check the sequence they started from, so two tabs
can't take the same sequence even without Web Locks. Deleting the log with the household, like the blob database,
is still to come.

## Private log (#489)

A member's private log is kept apart from every other store, in its own
database per member, `kin-private-log:<householdId>:<memberId>`, version 1
(`web/private/private-log-store.js`, modelled on the board log):

- `events`: `{ order, eventId, envelope }`, every private event as the signed
  envelope it travelled in, sealed under a member-key epoch. Only the member's
  account vault holds the member key, so the log needs no sealing of its own
  and root rotation doesn't touch it. Signatures are checked once, when an
  event arrives; reopening the log only decrypts.
- `ids`: `{ eventId, order }`, so each event is stored once even when two
  tabs store it together.
- `outbox`: `{ deviceSequence, eventId }`, this device's private events the
  relay hasn't accepted yet.
- `meta`: `{ key: "state", nextOrder, cursor, deviceSequence, provisional,
  refused, vault }`: the relay position read up to, this device's last
  private sequence ([SYNC](SYNC.md#private-relay-489)), the last 100 relay
  events skipped because they failed authentication, and `vault`, the last
  sealed account vault seen (`{ version, ciphertext }`, ciphertext under the
  vault key exactly as the service stores it) so an offline unlock can still
  open the member key. A cached version newer than the service's is preferred.

While Kin is unlocked the decrypted log is held in memory
(`web/chat/chat-records.js`, as the fridge does) for the engine's private log
to mirror, and the member key's epochs are held as non-extractable
CryptoKeys; locking zeroes and drops both. Writing and renumbering take a Web
Lock per member, and the store writes that add or renumber pending events
check the sequence they started from. The database is created only once the
device holds a vault key (ADR 0018); it stays on a device that leaves the
household, sealed under keys that device keeps, like the other logs.

Reminders and personal settings that follow the member (#520) are private
events in this log (kinds 120, 121 and 130); nothing about them is stored
anywhere else on the device in a readable form, except what the device
itself applies:

- The theme a synced setting picks is saved into the device's personal
  appearance record (`personal_appearance`, encrypted with the household
  data), so an offline unlock opens with it.
- Text size (`kin.text-size`: `large` or `larger`), Kin's reduced-motion
  override (`kin.motion`: `reduce`), whether reminders show as notifications
  (`kin.reminder-alerts`: `off`) and "Use different settings on this
  device" (`kin.settings-this-device`: `on`) are localStorage values, as the
  automatic lock and the app icon count (`kin.app-badge`) already were, so the
  lock screen shows the chosen size and motion. Defaults are stored as
  nothing. They say nothing about the household.
- Reminder timers are still in-memory only (`web/reminders.js`); a lock
  suspends them as before. The device remembers, in memory, which reminders it
  armed from the log and which it already showed, so a reminder never goes
  off twice in one session.

**Private blobs (#502).** Journal photos are kept in their own database per
member, `kin-private-blobs:<householdId>:<memberId>`, version 1
(`web/private/private-blobs.js`): `blobs` (`{ ref, ciphertext, storedAt,
pending }`, sealed bytes by reference, pending until the service has them)
and `retire` (`{ ref, queuedAt }`, references to delete on the service on
the next pass). Ciphertext only: each blob's key lives in the journal record,
under the member key. The journal's draft is not stored: it stays in the
unlocked page and locking discards it, like every Kin draft.

## Account key vault on the service (ADR 0018, #564)

Not a device store: the service keeps each member's sealed key vault in
server schema 21 (`account_vaults`, `account_vault_wrappers`,
`account_passwords`), with a forward migration from 20, purged with the
household. The vault holds the member's household and chat epoch keys (read
from this device's `epochs` store, opened with the device key), the member's
certification key and, once they use private storage, their member-key
epochs (contents format 2, ADR 0019), sealed by the member's device. No IndexedDB database or record format changes; the key database
stays at version 6. Formats and parameters: [CRYPTOGRAPHY](CRYPTOGRAPHY.md#account-key-vault-adr-0018).

## Handoff storage

The independent draft key is `kin.handoff.draft`; it is best-effort, tab-scoped, and cleared only if successful submitted text still matches. Handoff shares atomic append/counter transactions and content-free invalidation.

## v0.4.0 Talk

IndexedDB remains schema 1 without structural migration. Talk commands use the existing atomic event/counter transaction and Rust validation. Independent best-effort session draft kin.talk.draft clears only after its matching submission succeeds; older retry/completion preserves newer text. Content-free invalidation remains { type: "events-changed" }. See [V0.4.0](planning/V0.4.0.md).

## v0.5.0 Pulse

IndexedDB remains schema 1; no migration or second authority. Pulse shares atomic event/counter transactions. Original failed SET retry preserves timestamp/value/expiry. BroadcastChannel remains exactly { type: "events-changed" }; peers reload canonical events through Rust with explicit time. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

The three catch-up fields extend the existing `local_context` singleton; database version remains 1 with no store, key, or index change. A legacy context with all three fields absent is initialized in a read/write transaction over `events` and `local_context`, capturing the current tail without changing events or `next_logical_time`. Partial/corrupt metadata fails closed. `getCatchUpState()` reads ordered events and the local cursor in one readonly transaction. `markCaughtUpThrough(snapshotBoundary)` verifies the request and captured snapshot tail rows, then transactionally advances only when its local sequence is newer. It changes no canonical event and preserves `next_logical_time`.

Protocol v6 carries the stable cursor event ID; IndexedDB `local_sequence` stays browser-only. `events-changed` remains content-free. After a cursor commit, tabs send only `{ type: "view-state-changed" }`; receivers reread IndexedDB and recompute. Neither message includes an ID, cursor, count, text, actor, or device. See [V0.6.0](planning/V0.6.0.md).

## v0.7.0 Routines

Routine kinds 14–17 share schema-1 atomic event/counter transactions. Current-period writes first project saved bytes in Rust inside the transaction and compare the intent key; stale keys never retarget. No occurrence table or source-byte migration. `kin.routine.draft` is best-effort tab-local text/cadence, not household truth. See [V0.7.0](planning/V0.7.0.md).

## v0.9.x Encrypted Sync Storage

The `kin` IndexedDB v1→v2 upgrade is additive and non-destructive:

- `sync_state` keeps current/pending epoch, local relay cursor/high-water, device sequence, Lamport maximum, initialization state, pending signed rotation proposal and bounded queue count.
- `sync_outbox` is keyed by stable event ID and retains the exact canonical event bytes, chosen key epoch, device sequence, exact encrypted envelope and acknowledgement state. Retries reuse the same envelope. Accepted envelopes remain cached so a lower relay cursor after process restart can requeue identical bytes.
- `sync_bindings` stores encrypted control envelopes mapping legacy placeholder identities; it never replaces semantic event records. Verified binding context is separately retained in `local_context` for Rust v8 replay.
- The separate `kin-crypto-keys` database (schema 3) stores non-extractable device `CryptoKey`s, AES-GCM-sealed epoch key bytes, and `trusted_devices` peer-key pins. A pin records the locally compared fingerprint/public key so later service-directory substitution is rejected. Raw household keys never go to localStorage, cookies, URLs, or service state.

Each local append transaction covers `events`, `local_context`, `sync_state`, and `sync_outbox`; canonical bytes and the outbox record either both commit or both abort. On receive, authentication/decryption and v8 Rust replay happen before writes; exact canonical rows and transport cursor/high-water commit in one transaction. A pre-commit crash safely redelivers. The Since You Last Looked cursor remains independent and advances only through its own UI action.

The app limits canonical history/outbox to 10,000 local events and relay storage to 100,000 household envelopes; network batches are at most 20 events. There is no compaction/checkpoint implementation. Relay acknowledgements are process-local: service restart can lose ciphertext, while local canonical history and cached envelopes remain. Sync does not silently delete local data when remote state is absent.
