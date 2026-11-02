# Synchronization Design

**Status:** v0.24.0 preserves the existing encrypted-sync boundary. Item planning dates remain inside encrypted canonical event payloads, and the Last changed display value is derived client-side; no plaintext metadata, server interpretation, or new authority is added.

## Binary event transport (refactor Slice 10)

`POST /api/sync/events` and `GET /api/sync/events` carry encrypted event
envelopes as binary (`application/octet-stream`) instead of base64url text
inside JSON (owner decision D3: the JSON form is replaced, not kept beside
it). The envelope itself is unchanged: the browser encrypts and signs it as
before (`web/sync/crypto.js`), the relay validates and stores the same
object (`server/sync-contract.mjs`), and signatures cover the raw nonce and
ciphertext bytes, so nothing about authentication changes. One codec,
`web/sync/envelope-wire.js`, is shared by the browser and the server.

- An envelope record is 148 bytes plus its ciphertext: event, household and
  device IDs (16 bytes each), device sequence and logical time (u64), key
  epoch (u32), nonce (12), signature (64), ciphertext length (u32) and the
  ciphertext. Integers are little-endian; protocol and envelope version 1
  are implied by the format version.
- A push body is `KSEV`, version u16 = 1, count u16, then the records. A
  JSON body is refused with 415 and a malformed batch with 400
  (`sync_batch_invalid`). The media type must be exactly
  `application/octet-stream` (case-insensitive, parameters allowed), not a
  prefix match. A count above 20 is refused before any record is decoded.
  The acknowledgement stays JSON.
- A pull page is `KSEP`, version u16 = 1, flags u8 (bit 0: more pages),
  a zero byte, count u32, the next cursor (8 bytes), then per event its
  cursor (8 bytes) and record. Cursors stay opaque; clients keep them as
  unpadded base64url, the form the query string takes. Errors stay JSON.
- Decoding gives back exactly the object that was encoded: field order,
  lowercase hex IDs and canonical unpadded base64url. The relay's canonical
  duplicate comparison is therefore unchanged. A batch of 20 envelopes is
  48% smaller than the JSON it replaces for 150-byte events and 27% smaller
  for 4 KB events.

Request bodies are read with their limit enforced as they stream
(`server/http-body.mjs`): a declared `Content-Length` over the limit is
refused with 413 before any body byte is read, and a body without one is
refused as soon as it passes the limit, so no more than the limit is ever
buffered. Limits: 256,000 bytes for JSON control requests, 125,848 bytes for
an event batch (8-byte header + 20 × (148-byte fixed record + 6,144-byte
maximum ciphertext)), and the attachment limit for attachment and settings bodies.

## v0.24.0 Useful Household History

The date-only Item history value is derived during client-side replay from
existing encrypted canonical events. No timestamp is duplicated into
plaintext sync metadata and no actor/device or read-receipt state is added.
Distinct concurrent events continue to converge by the established
`(logical_time, device_id, event_id)` ordering.

## v0.22.0 Lightweight Planning Dates

Planning dates are schema-1 canonical Item events carried by the existing
encrypted local event store, outbox, retry, relay, revocation, and archive
paths. They are not duplicated into plaintext sync metadata. Concurrent
updates resolve by protocol 16's existing
`(logical_time, device_id, event_id)` order. Older protocols fail closed on
date-bearing history rather than dropping the field.

## v0.21.0 Household Modes

Explicit mode changes are canonical events and use the existing encrypted
offline store, retry, relay, revocation, and archive paths. Devices that sync
distinct concurrent changes converge through protocol 15's deterministic
`(logical_time, device_id, event_id)` replay ordering. Protocols 1–14 fail
closed on mode-bearing history or non-Normal projections. Sync adds no
plaintext mode metadata or server-side mode behavior.

## v0.20.0 Staples & Replenishment

Staple definitions and ordinary Shopping Items are canonical Item events and
remain inside the existing encrypted local/sync/archive boundaries. Manual
replenishment appends a separate Shopping Item with copied text; it does not
create inventory state, a source relationship, or a server-side operation.
Offline capture, retry, synchronization, and archive import/export continue
through the existing event adapters. Protocol 14 is required to replay
Staples; protocol 13 remains compatible with Shopping-only history.

## v0.17.0 Checklist Steps

Step events use the existing encrypted canonical-event envelope and can be
created offline. Local append and retry preserve the generated Step ID; after
sync, deterministic Rust replay uses the parent Item ID and stable Step ID.
Equal-logical-time archive versus completion/reopen from distinct devices
converges to archived. A same-time parent Item archive suppresses Step
mutations. A later change from another device, after another device archived or
completed the entity, is kept in history and has no effect. Revocation and
epoch rotation continue to govern access to the complete event stream; Steps
add no server interpretation or authority.

## v0.15.0 Areas

Area names, IDs, archive state, and Item assignments are ordinary canonical
household event payloads. They are encrypted with the same household content
key before entering the relay. Relay routing sees only the existing opaque
envelope metadata, never plaintext Area names. Offline create, rename, archive,
and assignment follow the existing retry/idempotency and deterministic replay
path. Revocation and epoch rotation continue to govern access to the entire
household event stream; Areas add no authority or server-side interpretation.

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

## Committed rotation recovery

A successfully committed rotation makes each package for an intended trusted
recipient durable recovery material until that recipient acknowledges it or
loses trust. The package remains bound to its original household, epoch,
recipient fingerprint, grant ID, and sender signature; server metadata marks
only packages created by the committed compare-and-advance operation as
recoverable after their ordinary pre-commit expiry. The client still verifies
the recipient binding and sender signature against the verified device-key
history before saving the key. Generic provisioning grants continue to expire
normally.

When a sender is revoked after commit, packages for still-trusted recipients
remain available, while packages addressed to a revoked, expired, or
key-transitioned recipient are removed. Acknowledgement records the received
epoch on that device. The rotating device records its own new epoch at commit.
This allows a remaining Adult to recover the committed epoch before performing
the rotation required by the access change; it does not let that Adult skip a
missing epoch or make its encrypted event history unreadable. Recovery packages
contain only recipient-wrapped keys, not server-held household content keys.

The recovery marker is assigned by the relay when it accepts the rotation;
fields in a submitted package body cannot set or clear it. Clients relax only
the expiry check, and only for a grant the relay marks this way whose signed
epoch is at or below the relay's current committed epoch; a newer epoch must
arrive unexpired. The expiry is part of the signed package metadata, so the
marker cannot make a package verify that would not verify otherwise.

Epoch numbers come only from signed packages. The grant's outer `keyEpoch`,
`senderDeviceId` and `grantId` are relay metadata and are not signed, so the
client refuses a grant unless each equals the signed package's value and the
package names this household and this device as recipient. A refused grant is
not saved or acknowledged, and sync pauses with an explanation. The key store
also refuses to save a sealed key under any epoch or household other than the
one it was sealed for. Durable validation rejects a marker on
an acknowledged, request-bound, or package-less grant. Grants stored before
the marker existed load as ordinary grants and keep their normal expiry.
Retained packages are bounded by `MAX_KEY_EPOCHS × MAX_ROTATION_PACKAGES`,
which exceeds the most a supported household can accumulate (127 rotations ×
at most 64 recipients), so retained recovery packages cannot block a
legitimate rotation. They do not count against the ordinary 128-transfer
limit. A recipient's own key migration still discards its outstanding
packages, because they are bound to its previous fingerprint.

A retried rotation reuses its pending key only while every device it was
already wrapped for is still a recipient (same device ID and key fingerprint).
If any of them has been revoked or re-keyed since, the pending proposal is
discarded and a fresh key and proposal ID are generated, so a relay that kept
the earlier package cannot hand the departed device the new epoch's key (#176).
Before discarding, the device re-reads the relay status: if the proposal
committed meanwhile (for example a lost response), it is accepted with its
original key instead, and the discard happens only while the relay is still at
the proposal's expected epoch. Rotation runs under a cross-tab Web Lock
(`kin-key-rotation`), so another tab can't commit the proposal between that
check and the discard; a tab that finds the lock held skips that pass. A recipient set that is unchanged or grows keeps the
pending key.

### Rotation and the account vault (#791)

The device that commits a rotation would otherwise be the only holder of the
new key until its vault keeper ran ([ADR 0018](decisions/0018-account-key-vault.md)).
If it holds the member's vault key, it downloads the member's vault, merges
in the pending proposal's key (opened from the proposal's self-sealed copy,
not installed) and sends the result sealed for the next vault version with
the commit: `vaultChange: { expectedVersion, ciphertext }`. The service runs
every rotation check first (epoch limit, retry, stale epoch, recipients,
packages, capacity), then stores the vault compare-and-set, then advances the
epoch, all in one database transaction; a refused vault change commits
nothing, and a refused rotation stores no vault change. A retried proposal
never touches the vault. The answer's `vault` is `{ version }` when the vault
was stored, otherwise null; an older service leaves it out.

On `vault_version_conflict` the device downloads again, merges and resends
the same proposal, at most three requests in all. After that, and on
`vault_not_found`, `vault_rate_limited`, `vault_invalid` or
`request_too_large`, it sends the proposal once without the vault change,
which is the older path: the keeper adds the key after it is installed. The
same happens without a vault key or a vault, or when the vault already holds
a different key for that epoch (another proposal committed, so this one is
refused as stale) or doesn't open. Any other refusal (such as
`stale_key_epoch`) is handled as before. The request body may be up to about
344 KB on this route, room for 64 packages and a 64 KiB vault.

A proposal downloads the vault once. When the service refuses the rotation
for its own reasons (the epoch limit, recipients, capacity), the tab keeps
the vault change and the next sync pass sends it again; it downloads again
only after a vault conflict, which means another device wrote the vault. Vault
downloads share the member's window with a new device's backup-code,
password or passkey sign-in, so a long refusal must not use it up.

A device whose first sync finds a rotation pending sets up its sync state
first, then commits the rotation. History it held before joining is queued
without a key epoch, like a new change, and its identity binding waits too, so
both are sealed under the new epoch, never the retired one; a binding sealed
earlier and not yet uploaded is re-sealed under the relay's current epoch (by
one tab only). Events from that earlier identity are not pushed until the
binding is on the relay. Changes already sealed or stamped before an access
change are still sent under their epoch once the rotation commits, as ordinary
queued changes are.

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

### Events that can't be applied yet (quarantine)

A remote event that decodes but doesn't fit this device's history (engine code 4, for example a completion delivered one page before the item it completes) doesn't stop sync. The relay cursor still advances, and the event's canonical bytes are kept in the encrypted `sync_state` record as `{ eventId, encoded, reason, firstSeenAt, attempts }` (`web/storage/quarantine.js`). Every later page that brings an event this device doesn't have yet replays the kept events with it, in canonical order. A kept event never stops a batch: if the engine refuses it for any reason (for example "unsupported" after an engine change), it stays kept, while the same failure on a page event still stops the batch. An event that applies, or arrives again as a duplicate, leaves the quarantine; one refused again counts another attempt and does not alert again. A kept event that is already in history, or that arrives again in the new page, is not replayed from the kept copy; history or the page copy decides, so a kept copy can never collide with them and stop sync.

- **Bound:** 100 rows and 64 KiB of canonical bytes (the rows are re-encrypted with every sync state write). Rows already kept stay; refusals beyond the bound are only counted, as every refusal was before v1.0. A row refused 20 times is moved to the count, so a true poison event can't fill the bound or cost a history replay forever. Bytes that can't be decoded at all are never kept, since retrying can't help them; they're counted too. `quarantinedEventCount` is kept rows plus counted refusals.
- **Review:** while events are kept, the device's status notice names up to three of them by short event ID with a plain-language reason, until they apply. A new refusal also shows it as a toast. It never shows bytes. With nothing kept the toast shows the earlier message.
- **Lifecycle:** the rows live in the same encrypted record as the sync cursor, so they're unreadable while Kin is locked and are removed with the sync state when the device leaves or the household is deleted. They aren't cleared on lock, because that would drop the only copy before the retry that would apply them; the relay re-sending an event is not relied on.
- An unreadable (code 2) or unsupported (code 3) event still stops the batch without advancing the cursor.

## Ordering and reconciliation

Use the deterministic ordering requirements in [EVENTS](EVENTS.md): logical time, then bytewise device ID, then event ID. The tuple defines reproducible replay order only. It is not a semantic “last write wins” policy and must not be presented as deciding who is right.

Implemented conflict behavior and remaining UX limitations:

| Concurrent operations                            | Required consideration                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both devices complete the same item              | Distinct completion facts are retained; replay is an idempotent state no-op after the first completion.                                                                                                       |
| One archives while another mutates               | A change from a different device at the same or a later logical time than another device's archive or completion is kept in history and has no effect. An earlier change applies, and the archive or completion still wins. Archive stays terminal. A device mutating something it archived itself still fails replay. A note created in an area another device archived at the same or an earlier logical time is kept with no area. Exceptions: an equal-time maintenance save against a reference another device archived still applies; a note update into an area another device archived keeps its text and leaves the note's current area unchanged; an equal-time reference save records field owners and leaves the saved text unchanged; completion can be undone by a reopen, per the row below. |
| One completes while another reopens              | Both facts remain; deterministic v8 tuple ordering selects the projection. The order is not semantic authority; the UI does not yet offer explicit conflict adjudication.                                     |
| Concurrent same-entity additions                 | Stable IDs are deduplicated; duplicate entity IDs from different event IDs fail closed rather than merge.                                                                                                     |
| Member/device removed while offline events exist | Authorization is checked at upload; revoked device sessions fail and old-epoch uploads cannot create new authorization. Local unsent canonical history remains local.                                         |

No generic CRDT or wall-clock last-write-wins policy is used. See the exact v8 replay rules and limitations in [V0.9.0](planning/V0.9.0.md).

## Push notifications after commit (v1.1)

When a push batch with new events commits, the relay asks the push service
(#85) to notify other members' subscribed devices. That happens after the
response is decided, in the background; it can't fail, delay or reorder sync,
and a duplicate-only batch notifies nobody. See [Push notifications](PUSH.md).

## Live channel (v1.1, #107)

A trusted device can hold one WebSocket to the service at `/api/live`, so the
service can say "something is new" at once instead of waiting for the next
poll. Household data still moves only over the HTTP sync routes, which stay
the fallback whenever the socket is closed.

- **Native.** RFC 6455 is implemented on `node:http`'s `upgrade` event and
  `node:crypto` (`server/live/websocket.mjs`): the handshake, a streaming
  frame parser, ping/pong and close handling. No extensions (no
  `permessage-deflate`), no subprotocols, binary messages only; every client
  frame must be masked; a message is at most 256 KiB in at most 128 frames.
  The parser is a loop over a header state machine and unmasks payloads in
  place.
- **Access.** The upgrade needs Kin's exact `Origin` (against cross-site
  WebSocket hijacking), a session on a trusted device of an active member, and
  a household not being deleted. One socket per device; a newer one replaces
  the older (close 4409).
- **Losing access closes the socket at once.** A signed-out or expired
  session closes with 4401; a revoked device, removed member or household
  being deleted with 4403. Revocation, replacement and recovery approvals,
  member and membership changes, sign-out and deletion re-check a
  household's sockets; a timer fires when the session or a Temporary
  membership expires; every ping (25 s) re-checks too, and two unanswered
  pings close the socket. A storage failure closes with 1011 (the upgrade
  answers 503), never as lost access. A client that half-closes is let go
  at once.
- **Backpressure.** Messages queue while the socket can't take more (a sync
  hint already waiting isn't queued again); past 1 MiB the socket closes
  with 4429 and the device catches up over HTTP.
- **Limits.** At most 4,096 sockets at once, counting those still closing;
  a device holds at most two (one open, one closing), so a device that
  reconnects in a loop can't crowd others out.
  Stopping the service closes every socket within a quarter of a second.
- **Messages.** Each binary message carries one record,
  `[u8 type][u8 flags][u16 reserved][u32 length][payload]`, little-endian.
  The service sends `HELLO` (1) when the socket opens and `SYNC_HINT` (2) to a
  household's other devices when events are accepted. Both are empty: a hint
  says neither what changed nor who changed it. Clients send only typing
  frames (record 3, see [Read receipts and typing](#read-receipts-and-typing-v11-120));
  the service also sends `RECEIPTS` (4, empty) when a member's receipt slot
  changed. An unknown record type closes the socket.
- **The client (#108, `web/sync/live-channel.js`).** An unlocked device opens
  the socket after its first sync and closes it on lock or sign-out. One
  tab per device holds it (a Web Lock named for the device); another tab
  takes over when that one closes or locks. `HELLO` and every `SYNC_HINT`
  make the coordinator sync over HTTP, so a reconnect resumes from the
  stored transport cursor, any gap is filled by the pull, and events the
  outbox kept while offline go out. A hint during a sync runs one more
  sync after it, at most once a second. The service hints when events are
  accepted and when keys, provisioning grants, identity bindings or a key
  rotation change. While the socket is up and the last sync succeeded, the
  coordinator polls every 30 s as a safety net; otherwise (no socket, or a
  sync paused on an error, no progress, missing keys or a rotation, or sync
  turned off) every 5 s. A dropped
  socket reconnects after a jittered, doubling wait (1-2 s at first, at most
  30 s; at once when the browser comes back online; the longest after being
  replaced by another socket for the device). Going offline drops the
  socket, since one can stay open across a silent network drop. Close 4401
  or 4403 ends the channel, and so does an HTTP sync refused for the
  session or device (an upgrade refused with 401/403 reaches the browser
  only as close 1006); the next successful sync starts it again. The client
  sends nothing on the socket, so no plaintext or envelope ever travels on
  it; events go up and down over HTTP only. That is a deliberate narrowing
  of #108's socket upload and inline envelope delivery, keeping one data
  path that #107 already secures. A browser whose content security policy
  doesn't let `connect-src 'self'` cover WebSockets simply keeps polling.

## Chat content blobs (v1.1, #110)

Each chat message's content (its text now, a photo or file later) is a
**content blob**: sealed on the device under its own random 32-byte AES-GCM
key (`web/chat/chat-blob-crypto.js`), kept outside the event log, and named
by the SHA-256 of its sealed bytes. The key travels only inside the
encrypted chat event, so the service stores ciphertext it can't open and
deleting the blob deletes the content.

- **Format 1:** version byte 1, a 12-byte random nonce, then the AES-GCM
  ciphertext and its 16-byte tag; the additional data binds the format. A key
  seals one blob only. Blobs are 29 bytes to 4 MiB plus 4 KiB.
- **Routes.** `PUT /api/chat/blobs/<ref>` stores a blob (raw bytes; the
  service checks they hash to `<ref>`, and nothing else). Storing the same
  blob again is a no-op. `GET /api/chat/blobs/<ref>` returns it, re-checked;
  404 means it hasn't been uploaded yet, and 410 `chat_blob_deleted` means it
  was deleted, which clients show as a deleted message rather than an error.
  `POST /api/chat/blobs/retire` with `{"refs": [...]}` (at most 64) deletes
  blobs. Every route needs a trusted device of a member who may take part in
  the household, and only reaches that household's blobs.
- **Deletion.** There is no direct `DELETE`. When the engine's chat page
  lists blobs as retired (an edit replaced one, its author deleted the
  message, an admin removed it), every device deletes its local copy, and the
  author's device (an admin's, for a removal) asks the service to retire
  them once the replacing event is accepted (#111). The service retires a live blob only for the member who uploaded it
  (from any of their devices) or a household admin, all of a request or none
  of it; already retired blobs are skipped. A retired blob keeps a tombstone
  (its reference, size, uploader and times, no bytes), so it is not served
  or accepted again. A device that was offline deletes its copy when it next
  syncs and reads a page.
- **Deleted before uploaded.** A retire that names a blob the service
  doesn't have yet (an outbox still holding the upload, an upload in
  flight) is kept as a claim for that member. The upload is refused (410)
  when it comes from the claiming member or when an admin claimed it; a
  claim by anyone else can't stop another member's upload, and it is
  dropped when the upload is stored. A device whose own blob is deleted
  while its upload is in flight also retires it right after the upload.
- **Erasure on the service.** Retiring drops a blob's bytes with SQLite's
  `secure_delete`, so freed pages are zeroed, and then checkpoints the WAL;
  household purge zeroes chat pages the same way and checkpoints after it
  commits. An admin removal's audit row commits together with the retire. Backups taken earlier
  still hold the bytes, and restoring one brings those blobs back as they
  were at the backup, tombstones included or not; devices that already
  deleted their copies keep their own record of the deletion.
- **Bounds.** Per household: 256 MiB of live blobs and 250,000 live blobs;
  beyond either, uploads fail with `chat_storage_full` until content is
  retired. Running counts keep every upload's check constant-time.
  Tombstones (at most 500,000 per household) and claims (at most 20,000 per
  member) never block retiring: past their bound the oldest are dropped
  (for claims, only the claiming member's own), after which a very old
  retired blob could be uploaded again by someone who kept its bytes. The
  bounds stand after #125's review (see "Chat capacity" below).
- **On the device,** blobs live in their own IndexedDB database per
  household ([STORAGE](STORAGE.md#chat-content-blobs-v11-110)).
- Household deletion purges every blob and tombstone at finalization. An
  admin removal adds a `chat_content_removed_by_admin` audit row with a count,
  never what was removed.

## Photos and files (v1.1, #114)

An attachment message is a chat event of kind 44 with content kind 2
(`attachment`, already in the engine). Its content blob is the **chat
attachment manifest** (format 1, `web/chat/chat-attachments.js`): JSON
sealed like any message, holding the caption and, per file, its name, type,
size, an optional thumbnail and its ordered parts. Each part, and each
thumbnail, is a content blob of at most 1 MiB of the file, sealed under its
own key. Limits: 10 files per message, 25 MB per file, names up to 200
characters, captions up to 4,000, a manifest up to 256 KiB.

- **Sending.** Each file is read and sealed in parts as it goes (no whole
  file in memory), then the manifest. Parts and thumbnails are uploaded
  first, the manifest last, and the event after all of them, so a receiver
  that sees the message finds every part. A send that fails while sealing
  drops the parts kept on this device. If the event itself can't be stored,
  the sealed parts stay in this device's blob store, as ciphertext that is
  never uploaded; nothing cleans them up yet, a known local leak of storage
  (not of content).
- **Photos** (recognized by their first bytes: JPEG, PNG, WebP, whatever
  their declared type) are drawn again on a canvas before sealing,
  which removes EXIF, GPS and camera metadata; a 320-pixel JPEG thumbnail is
  made from the same pixels. A photo over 40 megapixels, or in another format
  (HEIC, say), is refused with a message saying what to export.
- **Opening.** The manifest is opened once per room (checked for shape and
  sizes), then each part is fetched, checked against its reference and kept.
  A file's parts are joined into a Blob for a download or the viewer; nothing
  decrypted is stored.
- **Deleting.** Only deletion (for everyone, or an admin's removal) applies;
  attachments aren't edited. The deleting device names the manifest and its
  parts when it sends the delete, from its kept copy or by opening the
  manifest; the service retires them all in batches of 64, and each device
  deletes the parts it kept with the manifest. A device that never fetched a
  manifest has no parts to delete.
- **Preparing, cancelling and retrying (#115, #116).** `sendAttachments`
  reports `{ index, done, total }` bytes per file after each part and takes an
  `AbortSignal`: when it fires (or the room closes, or sealing fails) the parts
  already sealed for that send are retired and nothing is posted; an abort
  gives the caller `chat_attachment_cancelled`. Cancelling works until the
  message starts being posted (between files, between parts and after the
  manifest is sealed). If the room closes, or the post itself fails, the
  sealed parts stay on this device as ciphertext until the blob store's
  expiry sweep removes them. The composer keeps the files, so a failed or
  cancelled send is retried with the same draft.
- **Why 1 MiB parts rather than 64 KiB chunks with their own endpoints.**
  Every part is already a content-addressed blob sealed under its own random
  key and nonce, uploaded with an idempotent `PUT` by hash, so repeating an
  interrupted upload is harmless (a repeat of what the service has changes
  nothing), and a receiver
  checks each part against its reference and size before using it. The
  manifest, sealed inside the signed event, fixes the order, sizes and keys, so
  a truncated, reordered or swapped sequence fails closed (a part from the
  service that is not the one named is refused by its hash). Sealing holds one
  part at a time; opening a file holds that file's decrypted parts (25 MB at
  most) while joining them into a Blob. Smaller chunks and a second family of
  routes would add a new frozen layout and more requests without any of these
  properties changing, so the 1 MiB parts of manifest 1 stay.
- **Limits by the service:** a household holds 256 MiB of live blobs, so a
  message of ten 25 MB files can fill a small household's chat storage;
  uploads then fail with `chat_storage_full` and say so.

## Chat capacity (v1.1, #125)

Limits that keep one noisy device or a long-lived household from exhausting
the service, and what each does when reached. Every refusal is a stable code
the app turns into plain words (`noticeText` in `kin-chat.js`); nothing is
dropped silently, and refused messages stay on the sender's device.

| Limit | Value | Reached |
| --- | --- | --- |
| Chat events per household | 250,000 (`MAX_HOUSEHOLD_CHAT_EVENTS`) | `chat_limit` (413) |
| Live blobs per household | 256 MiB, 250,000 blobs | `chat_storage_full` (409) |
| Chat events per device | 120 a minute, new events only | `chat_rate_limited` (429) |
| Blob uploads per device | 120 a minute and 256 MiB per ten minutes, new blobs only | `chat_rate_limited` (429) |
| Other sync requests | 256 a minute per device (unchanged) | `sync_rate_limited` |

Re-sent events and blobs the service already holds cost nothing, so a retry
after a lost acknowledgement is never refused for it. A request is checked
against the window first and charged only once its events or blob are stored,
so a refused or failed one never uses up the allowance. Windows are in memory
per device (at most 4,096 tracked) and reset on restart. A rate-limited
device keeps its outbox and sends again on its next pass.

**Volume model.** A busy household of six sending 300 events a day in all (messages,
edits, deletes and reactions) reaches 250,000 events in about 2.3 years; the
blob quota, not the event count, is the earlier limit for households that
share photos and files. These bounds stand; the figures above are the model
to revisit if measured use differs.

**Seeing use.** `GET /api/chat/storage` (admin only, `household_admin_required`
otherwise) returns `{ bytes, byteLimit, blobs, blobLimit, events, eventLimit }`:
totals only. The chat access panel shows it as one line. Freeing space is
deleting messages with attachments (their content is retired).

## Board relay (#317)

The fridge's events (kinds 52–58, [ADR 0011](decisions/0011-family-fridge.md))
travel in a third stream, `server/board-relay-service.mjs`, with the chat
relay's envelope rules through the same shared core
(`server/event-stream.mjs`): the device's own envelopes only, under a key
epoch it holds; a gapless per-device board sequence counted apart from the
household's and chat's; identical-bytes idempotency; the logical-time advance
bound on the board stream's own clock; and pages that only show epochs the
reading device may read. Board events are sealed under the household key
epoch (there is no board key).

- **Routes.** `POST /api/board/events` takes a KSEV batch (at most 20
  envelopes); `GET /api/board/events?cursor=&limit=` returns a KSEP page of at
  most 200; `GET /api/board/status` returns `{ deviceSequence, latestCursor,
  events, eventLimit }`. Every route needs a trusted device of a member who may
  take part in the household; pushes also need household sync set up and wait
  out a pending key rotation (409 `sync_rotation_pending`).
- **Who can use the fridge (#323).** Adults always draw. The household admin
  sets Limited and Temporary members to **Draw**, **Look only** or **No access**
  with a fresh passkey (`/api/household/board-policy/options` and `/finish`,
  schema 19). Pushes need Draw (`board_read_only`, 403); status and pulls need
  more than No access (`board_unavailable`, 403). `GET /api/sync/status`
  carries `board.access`, and `board.policy` for an admin.
- **Limits.** 250,000 board events per household (`board_limit`, 413) and 240
  per device per minute (`board_rate_limited`, 429); a retry of events already
  held is free.
- **Hints, not notifications.** An accepted batch sends the ordinary live
  sync hint to the household's other devices. The fridge never sends a push.
- **Storage.** Server schema 18 adds `board_relay_state`, `board_events` and
  `board_device_sequences`, laid out like chat's tables
  (`durable-store/stream-events.mjs` serves both). Household deletion purges
  them with the rest.

## Private relay (#489)

A member's private events (kinds 100–199, [ADR 0019](decisions/0019-member-private-log.md))
travel in a fourth stream, `server/private-relay-service.mjs`, **keyed by
member instead of household**, through the same shared core
(`server/event-stream.mjs`, which takes the stream key, envelope check and
oldest readable epoch from each stream): the device's own envelopes only;
a gapless per-device private sequence counted apart from every other
stream; identical-bytes idempotency; the logical-time advance bound on the
member stream's own clock. Private events are sealed under the **member
key** (MK), not a household key epoch: the envelope's `keyEpoch` is an MK
epoch (1–128), which the service can only range-check, and every page shows
every epoch, since all of them are the member's own.

- **Routes.** `POST /api/private/events` takes a KSEV batch (at most 20
  envelopes); `GET /api/private/events?cursor=&limit=` returns a KSEP page of
  at most 200; `GET /api/private/status` returns `{ deviceSequence,
  latestCursor, events, eventLimit }`. No route names a member: each request
  reaches the session's own member's stream. Pushes need household sync set
  up (`private_sync_unavailable`, 409); a pending household key rotation
  doesn't pause them, since the member key is apart.
- **Who.** Only the member's own trusted devices. Another member's device,
  an admin's included, reaches only its own stream and can't post an envelope
  naming any device but its own (`event_envelope_invalid`); a removed member
  or a revoked device has no session; Temporary members are refused
  (`private_unavailable`, 403); Limited members are refused
  (`private_off`, 403) while the household admin has turned **private storage
  for children and teens** off (`/api/household/private-policy/options` and
  `/finish`, a fresh passkey like "Who can chat", schema 22, default on).
  `GET /api/sync/status` carries `private.access` (`write` or `none`), and
  `private.policy.limited` for an admin; `GET /api/household/settings` carries
  `privatePolicy` for an admin.
- **Limits.** 50,000 private events per member (`private_limit`, 413, the
  engine's private log cap) and 120 per device per minute
  (`private_rate_limited`, 429); a retry of events already held is free.
- **Hints.** An accepted batch sends the live sync hint to **the member's own
  other devices only**, so no one else's device learns when they write. No
  push notification.
- **Storage and purge.** Server schema 22 adds `private_relay_state`,
  `private_events` and `private_device_sequences` keyed by member (each with
  the member's household; no foreign key to members, like the account vault),
  served by `durable-store/private-events.mjs`. Removing a member purges their
  stream in the removal's transaction; household deletion purges every
  member's stream with the rest.
- **The device side.** `web/private/private-log.js` runs a private pass after
  the board pass in the sync coordinator, and only once the member key is on
  the device: it starts a new MK epoch if one of the member's devices was
  revoked after the newest epoch was made (the device directory each pass
  reads says so), pushes pending envelopes (resealing any under an older
  epoch), then pulls and authenticates each event: signed by one of **this
  member's** devices (its verified key history), not by a device revoked
  before the epoch it uses, a private kind, and the same identity inside as
  out. The member key comes from the account vault
  ([CRYPTOGRAPHY](CRYPTOGRAPHY.md#member-key-and-private-envelopes-adr-0019)).

### Private blobs (#502)

A member's journal photos and thumbnails are sealed on the device
(`web/private/private-blobs.js`): each under a fresh random AES-256-GCM key,
format 1 (version byte, 12-byte nonce, ciphertext and tag) with additional
data binding the format, the household and the member. The key travels only
inside the journal record that names the photo, which is sealed under the
member key, so only the member's own devices can open it. The blob's
reference is the SHA-256 of its sealed bytes.

- **Routes.** `PUT /api/private/blobs/<ref>` (the sealed bytes, checked
  against the reference; authorized before the body is read),
  `GET /api/private/blobs/<ref>` (404 `private_blob_missing` when not held)
  and `POST /api/private/blobs/retire` (`{ refs }`, at most 64; ones not held
  are skipped). `GET /api/private/status` adds `blobs`, `blobBytes`,
  `blobLimit` and `blobByteLimit`. No route names a member: each request
  reaches the session's own member's blobs, so another member's device, an
  admin's included, finds nothing. The same rules as the stream decide who
  may: never Temporary members, Limited ones only while the household allows
  it, never a revoked device.
- **Limits.** 29 bytes to 4 MiB + 4 KiB a blob (the household attachment
  bound), 2,000 blobs and 256 MiB per member (`private_storage_full`, 409),
  60 uploads a minute and 128 MiB per ten minutes per device
  (`private_rate_limited`, 429); an upload already held costs nothing.
- **The device side.** A sealed blob is kept locally as pending and uploaded
  on the next private pass, before that pass pushes events. A device opening
  an entry fetches what it lacks, checks it against its reference and keeps
  it. Deleting a photo (removed from an entry, or its entry deleted, once
  Undo has passed) drops the local copy and queues the reference; the next
  pass deletes it on the service. There are no tombstones: only the member's
  own devices name their blobs. A device drops cached copies the journal no
  longer names (never a pending one).
- **Storage and purge.** Server schema 24 adds `private_blobs` keyed by
  member, with the member's household (`durable-store/private-blobs.mjs`).
  Removing a member purges their blobs with their stream; household deletion
  purges every member's. Freed pages are zeroed.

## Chat relay (v1.1, #111)

Chat events are canonical events in the same signed, encrypted envelopes as
household events (protocol 1, envelope 1), but they travel in a stream of
their own (`server/chat-relay-service.mjs`) and land in the device's chat log
rather than the household history ([ADR 0008](decisions/0008-household-chat.md)).
Until the chat key exists (#123) they are encrypted under the household key
epoch, like household events. Chat and household envelopes share one signature and AAD
domain; the client tells them apart by kind (the household history refuses
chat kinds and the chat pass accepts only them). The chat key story (#123)
should also separate the two domains.

- **Routes.** `POST /api/chat/events` takes a KSEV batch (at most 20
  envelopes); `GET /api/chat/events?cursor=&limit=` returns a KSEP page of at
  most 200; `GET /api/chat/status` returns `{ deviceSequence, latestCursor }`
  for the calling device. Every route needs a trusted device of a member who
  may take part in the household; pushes also need household sync set up and
  wait out a pending key rotation (409 `sync_rotation_pending`).
- **The same envelope rules as the household relay:** the authenticated
  device's own envelopes only, under a key epoch it holds; each device's chat
  sequence (counted apart from its household sequence) has no gaps; a repeated
  event ID is accepted only with identical bytes; the logical-time advance
  bound applies to the chat stream's own clock; pages only show epochs the
  reading device may read. Its own cursor, sequence and quota (250,000 chat
  events per household) keep chat from counting against household limits.
  Accepted chat sends the same push and live hints as household events.
- **The client** (`web/chat/chat-room.js`) runs one chat pass after each
  successful full household pass of the sync coordinator (a household pass
  that pauses holds chat back too), and a message sent hints the coordinator
  at once. A pass uploads each pending event's content blob, then pushes the
  events in batches of 20 (at most two batches), then asks the service to
  retire the blobs those events replaced (an edit's old text, a deleted
  message's), then pulls up to five pages; a pass that leaves more continues
  on the coordinator's normal continuation schedule. Each pulled event is
  checked as household events are: from a device in the verified directory,
  not revoked before the current epoch, not from before its device's
  history, signed by one of that device's keys, and carrying the same event
  ID, household, author (the signing device's member), device and logical
  time inside as outside; its kind must be a chat kind.
- **Refused events.** An event that says something that can never pass (not
  a chat event, a mismatched identity, a revoked or not-yet-granted device)
  is skipped and remembered (the last 100) for the chat view to report, so
  one bad event from a member's device can't stop the household's chat. A
  signature that doesn't verify pauses chat once (the device may have
  changed its key after this pass read the directory) and is skipped only if
  it fails again on a later pass with a fresh directory. Anything else (a
  device this one doesn't know yet, a missing key epoch, a storage error)
  pauses chat until a later pass. Pushes take at most two batches a pass, so
  chat stays within a small share of the coordinator's request budget.
- **Chat access (#130).** The same directory gives each device a `chatAccess`
  (`none`, `read` or `write`) for its member, so a client knows who can read
  chat and so may be mentioned. Devices keep the last list they saw.
- **Admins.** Whose removals count comes from the service's own record: the
  device directory (`/api/sync/devices`) marks each device's member
  `householdAdmin`, the rule the service uses to let a member delete others'
  blobs. Devices keep the last list they saw, so removals show offline. The
  engine applies the list when it reads a page, so a removal counts while its
  author is an admin; a change of admins re-checks which blobs that retires. If the service refuses a blob deletion outright (the
  member isn't an admin by its record), the event is sent anyway, the blob
  stays on the service, and the refusal is reported; a deletion that fails
  for now is retried with the event.
- **Sequences.** A device's chat log starts with a provisional sequence. The
  first pass asks `/api/chat/status`: events written before then (offline,
  on a fresh device) are renumbered after the relay's count and sealed again.
  Later passes ask only while something is pending; events at or below the
  relay's count were accepted before a lost reply and leave the outbox
  without being sent again. A pending event sealed under an older key epoch
  is sealed again under the current one before it leaves the device.
- **Failure handling.** Chat trouble is reported to the chat room and the
  household pass still finishes; only lost access or a deleted household
  stops the whole pass. Blob requests go through the coordinator's guard
  (unlocked only, within its request budget, aborted when sync stops).
- **Quota.** At 250,000 chat events a household's pushes fail with
  `chat_limit` and outboxes wait; retention (#125) is what frees room.

## Delete for me (v1.1, #119)

Deleting a message "for me" hides it on all of the member's devices and
changes nothing for anyone else, so it can't be a household or chat event:
every member's devices hold those keys. Each member instead has one record on
the service (`GET`/`PUT /api/chat/hidden`, compare-and-set on its revision,
at most 256 KiB) holding the IDs they hid, sealed by `web/chat/chat-hidden.js`
(format 1):

- The IDs, 16 bytes each, sorted and packed, are encrypted with a new random
  AES-256-GCM key per revision (at most 10,000 IDs: 160 KB, about 213 KB in
  base64url, with room for 64 recipients). The additional data binds
  household, member, revision and the writing device.
- That key is wrapped to each of the member's trusted devices from the
  verified directory, by device and key fingerprint: an ephemeral ECDH P-256
  key and HKDF-SHA-256 to the device's agreement key. Other members' devices
  are never recipients. This stands in for a member-wide key provisioned to
  the member's devices (#119 suggested one): the record is the only thing such
  a key would protect, and sealing each revision to the member's current
  devices needs no new provisioning path; a revoked device simply isn't
  sealed to again.
- The writing device signs every field with its current key. A device opens
  a record only from a trusted, unrevoked device of the same member, for this
  household, member and the revision the service gave, and refuses a revision
  older than one it already saw.

Each chat pass asks only for the revision unless something changed (a hide
here, or the member's devices). Hiding works offline: the ID is kept on the
device and the next pass reads the record, adds it, and writes the result.
Hiding only adds, so two of the member's devices writing at once merge (the
loser of the compare-and-set reads and writes again). Keeping the record
alive:

- A device added or rekeyed since the last write can't open it. If another of
  the member's current devices can, that one writes it again on its next
  pass, sealed to the newcomer too; meanwhile the newcomer's own hides wait
  ("arrive once one of your other devices syncs").
- If none of the member's current devices can open it (all new or rekeyed),
  or its writer is no longer trusted (revoked, removed, rekeyed), a device
  writes it afresh from what it holds. Hides that only a device which is
  gone held are lost; every remaining device keeps its own.
- A device waiting on another that never syncs again (abandoned but not
  revoked) waits until that device is revoked.
- A record older than one a device already saw (a server restored from a
  backup, or one withholding a write) is never trusted to drop anything: the
  device writes back what it holds on top of it.

The record isn't compacted: messages deleted for everyone stay listed (they
show as "This message was deleted", which can itself be hidden), so the
10,000 limit counts every message a member ever hid; retention (#125) is
where old ones can go. A removed member's record stays on the service, sealed
to their now-untrusted devices, until the household is deleted. The service
sees only the record's size, timing and revision. It can't read, forge or
move one; it could withhold one (fewer hidden messages on a device that
hasn't kept them, until a device that has writes again).

## Unread position (v1.1, #133)

Unread tracking is a **private read position**: the cursor
(`postedAt`, `messageId`) of the newest message this member has had on
screen in a visible, focused window. It is separate from the read receipt
cursor ([receipts](#read-receipts-and-typing-v11-120)): it is kept whether
receipts are on or off, and nobody else ever sees it.

It travels in the member's own sealed record, the one that holds the hidden
messages above, so it is readable only by the member's trusted devices and
the service learns nothing from it but timing and size. Inside the record's
ciphertext the packed message IDs may be followed by a 24-byte trailer,
`postedAt` (u64, big-endian) then the message ID (16 bytes). A plaintext
whose length is a multiple of 16 has no position; one that is 8 more than a
multiple of 16 has one. Nothing else changes: version, additional data,
signature and the `PUT /api/chat/hidden` route are as before. Devices merge
by taking the later position (it only moves forward), so any order of
writes gives one result, and a device that read a message after the record
was built writes it on its next pass.

Everything else is computed on the device from the decrypted log: the count
of messages from others, not deleted or hidden, after the position, over the
newest 100 messages (`99+` past that); the "New messages" divider above the
first of them, placed when the chat is opened or returned to and not moved
while reading; the count on **Updates → Chat**; and the installed app's
badge through `navigator.setAppBadge` when the member turned that on (#476,
off by default). No count is sent to the service. The service sees each position change as a
new revision of the record, so it can tell when a member reads, though not
what; with no position yet (a new device, or before the first sync) every
message from others counts until the chat is opened.

Known limits of measuring by the posted time: a message written offline and
delivered after the member read past its time is not counted; a message dated
more than five minutes ahead of the clock is not counted until its time comes
(and a position that far ahead is ignored); and exactly 100 unread already
shows `99+`.

## Online now (v1.1, #128)

Who has Kin open and visible right now. Like typing, it is a sealed frame on
the live channel and nothing else: the service relays it and keeps nothing.

- **Frames.** Live record type 5 `PRESENCE`, both ways. The payload is a
  household-key sync envelope (JSON, at most 2,048 bytes, signed by the
  sending device) whose plaintext is `{ "v": 1, "kind": "online", "on": bool,
  "hello": true? }`. The service checks that it is small, valid JSON naming the
  sender's own household and device, and not faster than a burst of 6 with 1
  more every 2 seconds, then relays it unchanged to the household's other
  connected devices whose member has chat access (read-only members send and
  receive it: presence is not posting; "none" neither). It does not store,
  count, log or index it.
- **Heartbeat.** A device sends `on: true` every 30 seconds while Kin is
  unlocked (its chat room is open) and the page is visible, and `on: false`
  ("away") when it is hidden, locked or closing (best effort: a lock drops the
  keys with the room, so there the others' view simply runs out). The first
  heartbeat after unlocking, showing or reconnecting carries `hello: true`;
  devices that are online answer it with one heartbeat, at most once every 5
  seconds, so a newcomer sees who is here without waiting up to 30 seconds.
- **Receiving.** A receiver opens a frame only from a device in the verified
  directory that is another member's, drops replays (a per-device sequence
  that only rises) and frames sealed more than 15 seconds ago, and marks the
  member online until 70 seconds after the last heartbeat of any of their
  devices. Nothing is persisted; a reload starts empty.
- **Setting.** "Show when I'm online" (on by default) is the third setting in
  the receipt slot (`online`, absent means on); it is written last-wins like
  the other two, with the more private choice winning an exact tie. Turning it
  off sends "away", stops heartbeats, and makes this member's devices ignore
  everyone's frames (reciprocity), on every device of the member as it syncs.
- **Limit.** The live channel is held by one tab of a browser; if that tab is
  hidden while another tab of Kin is visible, the device reads as away.

## Ephemeral envelope (v1.1, #257, #258)

The live channel carries two things that must not be confused: notices and
household data pointers (durable, with HTTP as the source of truth), and
messages that exist only while a socket is open. This section is the second
kind; [ADR 0009](decisions/0009-ephemeral-signaling-boundary.md) explains why
they are kept apart. It is plumbing only: production accepts no category, no
feature uses it, and no calling, media or signaling feature ships with it.

**What is generic and what is chat.** Generic transport, which knows nothing
about chat: the handshake, framing, pings, the one-socket-per-device rule,
loss-of-access closing, backpressure and the connection limit
(`server/live/websocket.mjs` and the connection class). Chat-specific, which
sits on top: `SYNC_HINT` after accepted chat events, `RECEIPTS`, and the
`TYPING` and `PRESENCE` relays, which check chat access and the sealed frame's
household and device. The ephemeral path is generic like the first group and
gates on a category's declared access level, not on chat internals.

**Record.** Type `EPHEMERAL` (6), both ways. A request is `[u8 version =
1][u8 category][u8 scope][u8 0][16 correlation id][16 target id][u32 payload
length][payload]`; a delivery replaces the target with the **sender's member
and device IDs, stamped by the service** from the sender's session, and keeps
the correlation id, so a receiver can match a reply. Little-endian, 4096 bytes
of payload at most, a category's limit often lower. The payload is opaque to
the service; a payload that must be hidden from it is sealed under the
household key and bound to the sender's device, as typing frames are.

**Categories.** The service holds a closed table of categories, each with a
payload limit, a rate, the scopes it may use and an access level (`chat` to see
chat, or `write` to post in it). It is empty in production. A client cannot
invent one.

**Routing (#258).** A scope names who may receive: `household` (every other
open, allowed socket of the sender's household), `member` (every open trusted
device of one member of it, including the sender's other devices if the target
is the sender's own member) or `device` (exactly one trusted device). IDs are
the canonical member and device IDs pairing issues, never a display name or
role. A member with several devices gets one copy on each connected one, so a
receiver that wants one answer dedupes on the correlation id; there is no
acknowledgement. A device holds one socket, so a second tab does not receive
a second copy: the newer socket replaces the older (close 4409).

**Checked on the server, at dispatch, both sides.** Before relaying, the
service re-validates the sender's session and device, and for each receiver
that its device is not revoked, its member is active and not expired and its
household not being deleted, and that sender and receiver may take part under
the category's access level and the admin's chat policy. (A receiver's own
session expiring closes its socket on its own timer; only the sender's session
is re-read per message.) None of this is left to the browser.

**What the sender learns.** Nothing about delivery. A target that is in another
household, unknown, offline, revoked or not allowed gets nothing and the
sender gets no error, no acknowledgement and no different response, so the path
cannot be used to find out who is online, to scan device IDs or to learn a
device exists. Presence for people to see remains the opt-in "Online now"
feature (#128).

**Invalid envelopes fail closed.** Too short, nonzero reserved byte, a payload
length that doesn't match, or a scope without or with an unexpected target
closes the socket with 1007; an unknown version, category or a scope the
category doesn't allow with 1003; a payload over the limit with 1009. A message
over its category's rate is dropped, and a connection that keeps sending them
is closed with 1008. Version 1 is the only one; a client sending another is
treated like one sending an unknown record type, and falls back to polling.

**Lifetime.** A message goes to sockets open at that moment and is sent only
if the receiver's socket can take it: it is never queued, never retried and
never replayed after a reconnect, and nothing is written to a table, an event
log, an export, a log line or a push. Locking, signing out, removing a trusted
device or a member, deleting the household, and a key or authority change
that revalidates a household's sockets all close the sockets involved
(4401/4403, see Live channel), so nothing can be routed to them after that.

**Browser.** `web/sync/ephemeral-envelope.js` is only the codec for these
bytes; the live channel client ignores the record type until a feature adds a
consumer.

## Read receipts and typing (v1.1, #120)

Two small signals for the household chat, neither of them a chat event, and
neither ever sent or stored in the clear: the service sees only that
encrypted frames passed through.

**Read cursors (#121).** A receipt is a *cursor*, "read up to this message",
not a record per message, so storage is constant however long the chat grows.
Each member has one slot on the service (`GET /api/chat/receipts` for everyone's,
`PUT /api/chat/receipts` for their own, compare-and-set on `expectedRevision`),
latest only: it is overwritten, never appended to the chat log. A slot is a
household-key sync envelope (the same AES-256-GCM and ECDSA signature as a chat
event, `web/chat/chat-presence.js`), at most 4,096 bytes, whose
`deviceSequence` is the revision it replaces; the service checks that it comes
from the writing device, under a key epoch the household has, and nothing else.
Its plaintext (format 1) is the cursor (`postedAt` and `messageId`), when it
was read, and the member's two settings.

- A message counts as read by a member when it is at or before their cursor in
  (`postedAt`, `messageId`) order. A deleted message keeps its place, so it
  still counts toward the cursor. This is the order messages are posted in;
  two devices with clocks seconds apart can disagree on a message or two near
  the edge, which shows as seen slightly early or late. A message dated more
  than five minutes ahead of the reader's clock never moves a cursor, and a
  cursor that far ahead in a slot is read as none, so one message with a wrong
  clock can't mark everything after it as read. The cursor is "the newest
  message that was on screen", so a reader who opens a long unread backlog and
  sees only its end marks the messages before it as read too: the line means
  "has caught up to here", not "was shown every message".
- Cursors only move forward. Two devices of one member merge to the later one,
  and a lower cursor is never written over a higher one (the loser of a
  compare-and-set reads, merges and writes again). Other members' slots are
  trusted only from a device that is that member's, and an older revision than
  one already seen is ignored.
- The client marks a message read only when its row is at least half on screen
  in a visible, focused window with the chat showing (an `IntersectionObserver`
  on the rows, the page's visibility and focus), not when it was merely
  downloaded or a push arrived. It writes at most once every 2 seconds; the
  service allows 40 writes a minute per device.
- Settings, in the same slot so every device of the member sees them
  (the settings that were written last win; on an exact tie the more private
  choice wins, so devices agree, and a device that takes a newer setting also
  takes the slot's cursor, so it can't republish progress that was cleared):
  **Send read receipts** and
  **Show when I'm typing**, both on by default. Turning receipts off clears the
  stored cursor (the slot says "none"), stops collecting one, and hides other
  members' receipts from that member on all their devices: reciprocity. The
  settings share the slot, not the member's private "delete for me" record
  (#119) as the story suggested: that record is sealed to the member's own
  devices, so it couldn't carry anything the others should read, and the two
  settings are not secret from them anyway. A device that cannot open its own
  member's slot (it joined after a key change) fails closed: it sends no typing
  and no receipts, and shows none, until the member sets the settings on it or
  it reads a slot it can open. It still learns the slot's revision, so its
  writes don't conflict, and a device that has settings of its own re-seals the
  slot under a key it has (which can overwrite a newer privacy choice made under
a key this device lacks; the next device that has both fixes it). A device that
takes newer settings drops reads it hadn't yet reported, and re-marks the rows
on screen. A device whose clock is more than 15 seconds off neither shows nor
is shown as typing. The cursor and read time sit unencrypted in the
  device's local chat database beside the member list, as the other bookkeeping
  there does; the chat events themselves stay sealed.
- The slot is fetched when the chat opens, on a `RECEIPTS` live hint, and at
  most every 15 seconds on the chat pass. The "Seen by" line shows under the
  member's latest message ("Seen by everyone" when every other active member
  has); opening it lists each reader with the time of the report that covered
  the message.
- Where the story named Rust for the merge and projection: the cursors are
  per-member presence, not household or chat state (they are not events, are
  not replayed and are not part of any history), so they live beside the
  device's other presence code in JavaScript with tests, and the engine and
  its ABI are unchanged.

**Typing (#122).** Typing is ephemeral. The client sends a sealed frame
(the same envelope, plaintext kind `typing`, `on` true or false) over the live
channel at most every 3 seconds while the composer has new input, and `on:
false` on send, clear, blur, lock or page hide. The service relays the frame
unchanged to the household's other connected devices whose member may chat,
and keeps nothing: it checks only that the frame is at most 2 KiB, is JSON, and
names the sender's own household and device, and it drops frames faster than a
burst of four then one a second (a connection that keeps sending them is
closed). A receiver verifies the frame like a chat event, drops one that is
not newer than the last it accepted from that device (the sequence is the
sender's clock in milliseconds), or that was sealed more than 15 seconds before
or after its own clock (so a replay of an old frame shows nothing, though one
replayed within those seconds of being sent can), and shows the
indicator for 6 seconds unless refreshed, so it disappears within 6 seconds of
the person stopping, closing, locking or losing connection (the "stopped"
frame on lock is best effort: the keys go with the lock, and the 6 seconds is
what is guaranteed). Nothing about
typing is written to disk on either side. Turning it off stops this device
sending; the member still sees others'. The indicator is visible text beneath
the list and is the log's accessible description, not a live region, so screen
readers aren't interrupted on every change. Only the tab that holds the
device's live channel (one per device, by Web Lock) sends or receives typing,
so with several tabs of Kin open, typing shows in the one that holds it.

## Chat access policy (v1.1, #123)

The household admin decides whether Limited members (children) and Temporary
members (babysitters, guests) can use the chat. Each of the two groups is set
to **read and post** (the default for every household), **read only** or **no
access**; Adults always read and post.

- **Authorization metadata, in plaintext.** The policy is three columns on the
  household (`chat_limited`, `chat_temporary`, a revision) because the service
  has to enforce it. It holds no chat content. Changing it is admin-only and
  needs a fresh passkey (`POST /api/household/chat-policy/options`, then
  `/finish`), like other admin changes; a household with no recorded admin
  fails closed and keeps the default. Each change is audited as
  `chat_policy_changed` with the new values and revision, nothing else.
- **The service enforces it** on every chat call. *Read only* may pull events,
  read blobs and receipts, and delete messages for themselves; posting events,
  uploading or retiring blobs, writing a receipt slot and sending typing are
  refused (`chat_read_only`, 403). *No access* refuses everything
  (`chat_unavailable`, 403) and stops the typing and receipt signals to that
  member's open connections. Uploads are refused before the body is read. The
  check happens at the start of each request, so a change applies to the next
  call from members who are online, and `GET /api/sync/status` tells their
  devices (`chat.access`) on the next pass or hint.
- **Beyond requests.** Chat push notifications and live "sync now" hints skip a
  member with no access, and restoring an older backup keeps the current
  policy (it is authority, like the admin flag), so a restore cannot reopen
  chat. A message queued by a member who then became read only stays on their
  device, marked "Not sent: chat is read-only for you", and sends if access is
  restored. The device remembers the access level it was last given, so it does
  not show a composer while offline.
- **Experience.** A read-only member sees the chat with the composer replaced
  by "Your household has set chat to read-only for you." and no edit or delete
  of their own messages; a no-access member doesn't see Chat in Updates, and
  their chat pass fetches and sends nothing. The admin's panel is under
  Household → Identity & appearance.
- **Where this differs from the story.** The story also asks that Rust
  validation reject posts from members who can't post. The log has no record
  of when the policy changed, so a client cannot tell a post made before a
  member became read only from one made after; the service, which sees each
  push when it happens, is the check. Clients show what the service accepted.
- **Cryptographic separation** is the dedicated chat key, below.

## Dedicated chat key (v1.1, #123)

Chat travels in household envelopes, which every trusted device can open. So
that a member with no access cannot read chat sent after they lose it, the
event inside each envelope is sealed again under a **chat key** that only
devices of members allowed to read are given.

- **Format.** The decrypted envelope plaintext is either the engine's event
  (starts `KINE`, from before the household had a chat key) or
  `KCK1 | chat key epoch (u32 BE) | nonce (12) | AES-GCM(event)`, bound to the
  household, event ID and epoch. The envelope's outer fields (sender, time,
  sizes) remain visible to anyone with the household key; the message content,
  which sits in blobs whose keys are inside the event, does not.
- **When there is a key.** A household has none (epoch 0, chat as before) until
  the policy shuts someone out. The service then reports `chat.key.pending` on
  `GET /api/sync/status` and refuses chat pushes (`chat_key_rotation_pending`,
  409) until an Adult's device, which sees `chat.key.action = "rotate"`, makes
  the key and uploads one wrapped package per device allowed to read
  (`POST /api/chat/keys`). Packages are the existing key transfer (ECDH P-256
  to the device, signed by the sender) labelled with the family
  `chat:<household>`, so one cannot pass for a household key. The service
  checks each package against the device it names, that the set is exactly the
  devices allowed to read, and compare-and-sets the epoch; it never sees a
  key.
- **Rotation triggers**, all computed from who holds a package versus who may:
  a class set to no access (or a Temporary member expiring), a member removed,
  a device revoked. A device that gains access, or is added, is **granted** the
  keys it lacks by any device that holds them (`action = "grant"`), so it can
  read history, including what was sent while it had no access.
- **Plain events are refused once the key begins.** The service records the relay
  position where the first chat key took effect (`chat.key.since`). From there
  on a reader refuses an event that isn't sealed (anyone holding only the
  household key could have written it), so a modified client cannot slip
  readable chat into a keyed household. A push carries the chat key epoch it
  was sealed under (`X-Kin-Chat-Epoch`); the service answers
  `chat_key_stale` (409) for a sender whose view is behind, which seals again
  and sends on the next pass. A sealed event naming an epoch beyond the
  household's is looked at a second time before it is skipped, and one sealed
  under an epoch no device that may read still holds (`chat.key.lost`) is
  skipped at once, so neither stalls chat.
- **Who may share keys.** A rotation and a grant both need an Adult's device
  that is allowed to chat, the same trust the household key has. The service
  cannot check a package's signature or contents, so a device that finds it
  cannot open one of its own drops it (`POST /api/chat/keys/reject`) and is
  offered a fresh one; a malicious Adult could still hand out a wrong key, as
  they could with the household key.
- **Devices** fetch their packages with `GET /api/chat/keys`, verify the signer
  against the verified device directory, and store the key sealed in the device
  key store under the family label, so root rotation re-seals it with the
  household keys. A device without a key at some epoch pauses chat with a
  plain notice until one is shared. Messages queued before a rotation are
  sealed again under the new key before they leave.
- **Limits, honestly.** A device that lost access keeps what it already
  decrypted and every chat key it held. Read receipts, typing and delete-for-me
  records still use the household key: the service refuses them to no-access
  members, but that is enforcement, not encryption. A rotation needs an Adult's
  device that is allowed to chat to be online (a grant too, except that any
  other member's device may share an epoch no Adult's device holds); until then chat is paused for
  everyone so nothing is sent under a key a shut-out device holds. A household
  that already shuts a class out when it upgrades is paused the same way until
  an updated Adult device rotates. The key epoch count is capped at 128, as the
  household key's is; there is no recovery path past it.

## Household features (#624, ADR 0021)

A household admin can switch features off for everyone
([ADR 0021](decisions/0021-kin-for-everyone.md) §2; the page is in
[UX](UX.md#household-features--adopted-623-adr-0021)).

- **Stored on the service**, in plaintext like the access policies:
  `households.features_off` (server schema 25), a bit set where bit 0 is
  Chat, 1 Fridge, 2 Meals, 3 Routines, 4 Taking turns, 5 This week, 6 Talk
  later, 7 Store sections, 8 Shopping mode, 9 Maintenance, 10 Notes &
  reference, 11 Sitter page, 12 Journal, 13 Just for me (0 = everything on),
  and `features_revision`. `server/pairing-service/shared.mjs` and
  `web/features.js` name the same bits; the list only grows and a bit is
  never reused.
- **Changed** with `POST /api/household/features/options` then `/finish`,
  body `{ off, expectedRevision }`: a household admin only (403
  `household_admin_required`), with a fresh passkey or, for an admin without
  one, a password re-entry. Unknown bits are refused (`features_invalid`,
  400); a revision that isn't the household's current one is refused
  (`features_stale`, 409) at both steps. The answer is `{ off, revision,
  changed }`. Each change is audited as `household_features_changed` with the
  set and revision, and online devices are told to look now (the live
  channel revalidates chat signals and hints a sync).
- **Delivered** to every member in `GET /api/sync/status` as `features: {
  off, revision, admin }`. Devices keep the last set in localStorage
  `kin.household-features` and ignore an answer older than the revision they
  kept.
- **Enforced** for Chat and Fridge only: while either is off, `chat.access`
  and `board.access` are `none` for every member and their routes refuse as
  for "No access" (`chat_unavailable`, `board_unavailable`). The chat key's
  holders are derived, not stored, so switching Chat back on finds them as
  they were. Everything else is a layout on the devices
  ([THREAT-MODEL](THREAT-MODEL.md#household-features-are-a-layout-except-chat-and-fridge-623)).
- **Bit 15** is the Chore chart (#676); bit 14 is reserved for the Calendar
  ([ADR 0022](decisions/0022-family-hub.md) §2).

## Adults on the chore chart (#676, ADR 0022 §6)

Children are on the chore chart; adults join only if a household admin
allows it, and then each adult opts in themselves in the household history
(event kind 79, [EVENTS](EVENTS.md#the-chore-chart-676)).

- **Stored on the service** like household features:
  `households.chore_adults` (0 or 1, 0 by default) and
  `chore_adults_revision` (server schema 28).
- **Changed** with `POST /api/household/chore-chart/options` then `/finish`,
  body `{ adults, expectedRevision }`: a household admin only, with a fresh
  passkey or password, as for household features. A non-boolean or bad
  revision is refused (`chore_chart_invalid`, 400), a revision that isn't
  the current one (`chore_chart_stale`, 409) at both steps. The answer is
  `{ adults, revision, changed }`; each change is audited as
  `chore_chart_adults_changed`, and online devices are hinted to look.
- **Delivered** to every member in `GET /api/sync/status` as `choreChart: {
  adults, revision, admin }`. A device ignores an answer older than the
  revision it holds; it keeps nothing on disk, so an offline device shows
  adults only once it has heard the setting this session.
- **Enforced on the devices only.** The service never sees the chart: it
  can't read the history. Turning the setting off takes every adult off the
  chart on the next read, without removing their own "joined" choice, so
  they are back if it is turned on again. The host refuses "Join" while the
  setting is off; "Leave" always works.
- Which members are children and Adults comes from the device directory's
  `memberKind`, which the sync coordinator hands the app as
  `memberKinds`.

## Privacy boundary

Ciphertext payloads conceal content only to the extent that key management and client integrity hold. The relay can still observe routing IDs, ciphertext lengths, timing, delivery patterns, and possibly IP/log metadata. Document retention and access controls for these fields. Do not claim perfect anonymity, complete metadata privacy, or protection from a compromised authorized client.

## v0.9.x Protocol Record

The local service exposes authenticated `/api/sync/status`, `/api/sync/devices`, `/api/sync/events` push/pull, `/api/sync/bindings`, provisioning grant/acknowledgement, and epoch compare-and-advance operations. Every route uses the existing active-member, trusted-device, session, household and revocation checks. Households are bounded to four active adults and 16 trusted devices. The built-in server binds loopback only; use a trusted TLS-terminating proxy for external HTTPS origins. Other bounds: 128 epochs, 128 live provisioning grants, 256 sync requests/device/minute, 20 events or identity controls/batch, 200 KiB/request, 8 KiB/envelope, 10,000 local/outbox events, and 100,000 relay events/household. Sync cursors are opaque base64url relay sequences and never reuse the local catch-up cursor.

The browser stores non-extractable device keys and sealed epoch keys in a separate IndexedDB database. Canonical event rows remain the state authority in `kin` schema 2; `sync_state`, `sync_outbox`, and `sync_bindings` are separate stores. Each new local event and its outbox entry commit atomically. The exact encrypted envelope is retained through retry and after acceptance so a cursor reset after relay restart can requeue the same bytes. A downloaded event advances the transport cursor only in the same transaction as canonical-byte persistence and successful Rust replay. The UI acknowledgement cursor remains independent.

The v0.9.3 baseline duplicated canonical layouts and fixed-offset metadata reads
in browser code. v0.10.0 resolved that debt with Rust-owned commands/codecs and
validated metadata through the narrow WASM adapter; see [ARCHITECTURE](ARCHITECTURE.md).
v0.10.3 additionally rechecks the durable local epoch after each awaited sync
response so a missed peer notification cannot resume private-key use under a
disposed root. Networking and Web Crypto remain browser responsibilities.

The server is intentionally in-memory in this incubation. It returns `durable: false`; full restart loses household identity/session and service-side relay records, and v0.9.x has no way to restore the same authenticated household. A relay-only cursor reset while identity state survives is detected; clients retain local canonical bytes and cached exact envelopes for retry. Sync is not durable across full restart, and ciphertext authored only by a device whose local state is lost may be unavailable. A newly joined/replacement adult receives current and later epochs only; v0.9.x does not grant pre-join epoch keys, so earlier history remains unavailable. All-device loss may make encrypted data unrecoverable.
