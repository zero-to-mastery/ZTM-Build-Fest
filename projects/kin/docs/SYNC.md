# Synchronization Design

**Status:** v0.11.7 implementation candidate; awaiting human review. Existing encrypted envelopes and v8 canonical replay remain compatible. The local outbox, sync state, epoch secrets and private device keys are encrypted at rest and unavailable while locked. Signed device-key successors preserve verification history and repair entitled post-join epoch grants. The candidate stores identity, authorization and opaque relay state in SQLite and acknowledges an event only after commit; the service remains a relay, not a household source of truth.

## Intended direction

## v0.10 local security integration

v0.10.2 replaces only the local storage root. Exact device private serialization,
epoch self-seals, pending transition/provisioning/rotation records, pins, bindings,
outbox and cursors survive re-protection. Sync epoch/device transport keys are not
rotated as a side effect. Peer locks dispose old adapters and durable root/epoch
guards reject stale operations.

**Stable archive decision: Option A, intentionally local-only recovery.** Restore
does not establish membership, trusted-device enrollment or epoch entitlement.
Sync reattachment requires a separately authorized future workflow and is not
partially supported. v0.13 must make the archive/authority boundary an explicit
recovery decision; v0.14 must present it without implying that an archive
restores membership or device trust.

Transport envelope/protocol v1 and canonical event protocols v1–v8 remain unchanged.
Local canonical events/outbox copies, epoch records and device private serializations
are now protected by the unlocked local vault; transport encryption alone never
substitutes for this protection. Sync starts only after unlock and stops/aborts on
lock. Browser adapters read validated Rust metadata instead of canonical offsets.

Migration replaces nonextractable legacy private keys through a versioned signed
successor certificate with expected fingerprint, identity and monotonic generation
(at most 16 transitions). The server verifies and accepts exact retries, publishes
bounded public verification history and removes obsolete provisioning packages.
Peers authenticate the chain from existing pins; historical exact envelopes and
approval certificates retain their original signatures. Fingerprint-bound retry
state reprovisions entitled current/history epochs after transition. A queued
transition is accepted before pairing or sync, even if sync itself is disabled.
Local offline migration can finish while that network transition remains pending.

Archive restore is explicitly local-only and cannot silently rejoin sync; see
[PORTABILITY](PORTABILITY.md). A separate verified service-database backup is
required to recover server authority. Sessions and unfinished pairing/login
flows expire on restart; a trusted device must reauthenticate with its passkey.
Member removal/device revocation still reserves future sync key epochs and
cannot erase prior plaintext/keys. Local recovery possession is a separate
authorized path; removing a server member does not magically revoke a copied
recovery key/root.

## v0.10.1 interrupted rotation recovery

Before retrying a pending rotation, refresh authenticated server status and the
verified device directory. If the proposal already committed, recover its exact
sealed epoch key without replacing its packages. Otherwise refresh expired
packages or packages bound to superseded sender/recipient keys and the current
active recipient set. Keep the proposal ID, sealed epoch key and fingerprint;
only recipient packages and optional issuer-fingerprint retry metadata change.
An older request accepted during this refresh still identifies the same key.

Replacing pending packages compares the complete expected pending record in one
encrypted IndexedDB transaction. Completion and removal match the proposal ID,
so a stale tab cannot clear a newer proposal. Completion preserves the local
rotation barrier until an authoritative server-status update releases it; local
events created while another rotation is required retain an unassigned epoch.

The service keeps its latest committed proposal identity across a later access
change while marking the following rotation pending. Uploads remain blocked by
that pending state. A competing accepted proposal requires an authorized transfer
of its key; the losing local proposal never supplies the accepted epoch key.
No canonical event, transport-envelope or database-schema version changes.

## Historical transport progression

```text
Device A
   |
   v
local event
   |
   v
Rust validates domain event
   |
   v
IndexedDB append
   |
   v
client encrypts event payload
   |
   v
authenticated encrypted-event relay
   |
   v
Device B receives ciphertext
   |
   v
decrypt after device authorization
   |
   v
Rust validates, orders, and replays
   |
   v
derived household state
```

Each device remains useful offline. Events are committed locally first, queued for later upload, and retried safely. The receiver deduplicates by stable event ID, validates the event version, and reconstructs state using the deterministic ordering contract. No sync is included in v0.1.0.

## Server responsibility

The server is an authenticated encrypted-event relay, not the household source of truth, relationship analyst, plaintext event processor, or domain rules engine. Clients encrypt/decrypt household payloads and Rust validates/replays domain events. The server may authenticate accounts/devices, authorize access to a household's relay channel, store/forward ciphertext, enforce quotas/rate limits, and return opaque cursors.

Minimum routing metadata may include opaque household/channel ID, authorized device/account reference, event ID or opaque relay cursor, ciphertext size, upload/receipt time, and delivery status. Network services may also observe IP address, connection timing, and transport metadata. Minimize retention and access; encrypted content does not mean anonymous traffic.

The service must not receive plaintext household event payloads or household content keys. Authentication metadata and transport security remain necessary in addition to payload encryption. See [Cryptography](CRYPTOGRAPHY.md).

## Offline and delivery semantics

- Local event persistence succeeds before an event is considered locally accepted.
- Upload is at-least-once; clients must tolerate repeated delivery.
- Exact event duplicates are idempotent under the v0.0.4 event contract.
- Acknowledgement in the v0.11 candidate means the transaction committing ciphertext and its relay/device sequence returned successfully; it does not mean that another member received/read/agreed with it, that a backup exists, or that hardware/filesystem failure is impossible.
- A device may remain offline indefinitely; later synchronization must not rely on wall-clock timestamps as ordering authority.
- Authorization is checked on every sync operation. Revoked-device queued events are rejected unless an explicit, reviewed recovery procedure says otherwise.
- A client unable to decrypt or interpret an event must preserve it and surface a recoverable compatibility error; it must not silently drop it.

## Ordering and reconciliation

Use the deterministic ordering requirements in [EVENTS](EVENTS.md): logical time, then bytewise device ID, then event ID. The tuple defines reproducible replay order only. It is not a semantic “last write wins” policy and must not be presented as deciding who is right.

Implemented conflict behavior and remaining UX limitations:

| Concurrent operations                            | Required consideration                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both devices complete the same item              | Distinct completion facts are retained; replay is an idempotent state no-op after the first completion.                                                                                                       |
| One archives while another mutates               | A concurrent equal-Lamport action from a different device is retained as a no-op when archive sorts first; archive is terminal. A causally later action after observing archive fails replay and pauses sync. |
| One completes while another reopens              | Both facts remain; deterministic v8 tuple ordering selects the projection. The order is not semantic authority; the UI does not yet offer explicit conflict adjudication.                                     |
| Concurrent same-entity additions                 | Stable IDs are deduplicated; duplicate entity IDs from different event IDs fail closed rather than merge.                                                                                                     |
| Member/device removed while offline events exist | Authorization is checked at upload; revoked device sessions fail and old-epoch uploads cannot create new authorization. Local unsent canonical history remains local.                                         |

No generic CRDT or wall-clock last-write-wins policy is used. See the exact v8 replay rules and limitations in [V0.9.0](V0.9.0.md).

## Privacy boundary

Ciphertext payloads conceal content only to the extent that key management and client integrity hold. The relay can still observe routing IDs, ciphertext lengths, timing, delivery patterns, and possibly IP/log metadata. Document retention and access controls for these fields. Do not claim perfect anonymity, complete metadata privacy, or protection from a compromised authorized client.

## v0.9.x Protocol Record

The local service exposes authenticated `/api/sync/status`, `/api/sync/devices`, `/api/sync/events` push/pull, `/api/sync/bindings`, provisioning grant/acknowledgement, and epoch compare-and-advance operations. Every route uses the existing active-member, trusted-device, session, household and revocation checks. The built-in server binds loopback only; use a trusted TLS-terminating proxy for external HTTPS origins. Bounds: 16 active devices/household, 128 epochs, 128 live provisioning grants, 256 sync requests/device/minute, 20 events or identity controls/batch, 200 KiB/request, 8 KiB/envelope, 10,000 local/outbox events, and 100,000 relay events/household. Sync cursors are opaque base64url relay sequences and never reuse the local catch-up cursor.

The browser stores non-extractable device keys and sealed epoch keys in a separate IndexedDB database. Canonical event rows remain the state authority in `kin` schema 2; `sync_state`, `sync_outbox`, and `sync_bindings` are separate stores. Each new local event and its outbox entry commit atomically. The exact encrypted envelope is retained through retry and after acceptance so a cursor reset after relay restart can requeue the same bytes. A downloaded event advances the transport cursor only in the same transaction as canonical-byte persistence and successful Rust replay. The UI acknowledgement cursor remains independent.

The v0.9.3 baseline duplicated canonical layouts and fixed-offset metadata reads
in browser code. v0.10.0 resolved that debt with Rust-owned commands/codecs and
validated metadata through the narrow WASM adapter; see [ARCHITECTURE](ARCHITECTURE.md).
v0.10.3 additionally rechecks the durable local epoch after each awaited sync
response so a missed peer notification cannot resume private-key use under a
disposed root. Networking and Web Crypto remain browser responsibilities.

The server is intentionally in-memory in this incubation. It returns `durable: false`; full restart loses household identity/session and service-side relay records, and v0.9.x has no way to restore the same authenticated household. A relay-only cursor reset while identity state survives is detected; clients retain local canonical bytes and cached exact envelopes for retry. Sync is not durable across full restart, and ciphertext authored only by a device whose local state is lost may be unavailable. A newly joined/replacement adult receives current and later epochs only; v0.9.x does not grant pre-join epoch keys, so earlier history remains unavailable. All-device loss may make encrypted data unrecoverable.
