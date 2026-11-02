# Retention, Archival, and Deletion

**Status:** Household deletion and server lifecycle retention are implemented
through the v0.12.3 review candidate. The service holds opaque ciphertext and
limited authorization/routing metadata; it does not hold household plaintext or
content keys. See [V0.12.0](planning/V0.12.0.md) for the user-facing lifecycle contract.

## Distinct operations

| Operation | Meaning | What it does not mean |
| --- | --- | --- |
| Archive | Hide a domain item/record from normal views using an explicit tombstone event; retain canonical history for replay. | Household erasure or physical removal. |
| Member removal | End one member's authorization and revoke their devices under the membership protocol. | Household deletion or retrieval of previously copied data. |
| Device revocation | Reject future sessions/sync and rotate access for an active household. | Erasure of local plaintext, keys or prior copies. |
| Household deletion | Block household authority immediately, allow a 30-day cancellation period, then purge service-controlled household data and retain a minimal anti-resurrection tombstone. | Remote erasure of local, exported, offline or externally backed-up copies. |
| Local reset | Remove data from one reachable browser/profile using its local controls. | Erasure from the service, another device or an export. |
| Encrypted archive | User-created portable local copy, encrypted under its separate archive/recovery boundary. | Server backup, sync identity or deletion tombstone. |

Archive is routine domain state; deletion is an authenticated service lifecycle.
Never overload one control or event to imply both.

## Service lifecycle retention

| Data class | Owner and retention |
| --- | --- |
| Active household identity and membership | Durable service database until member/household transition; minimum information needed to authenticate and authorize. |
| Trusted/revoked devices and credentials | Durable while the household is active or deletion is pending. Purged at final deletion. |
| Pending request metadata | Request time and finalization deadline only; retained for up to 30 days to implement cancellation. Request invalidates every household session immediately. |
| Household tombstone | One row containing the opaque household ID, version, `deleted` state and deletion timestamp; retained indefinitely because it is the only in-database protection against restoring an older backup over a deletion. It contains no members, credentials, device identifiers, event ciphertext or audit content. |
| Encrypted events, identity bindings, relay/device cursors and key epochs | Retained while active and throughout the 30-day pending window; all purged at finalization. These are opaque ciphertext and routing/coordination state. |
| Sessions and ceremony flows | Sessions are in-memory, expire within 12 hours, and are invalidated on deletion request. WebAuthn flows are in-memory with a 2-minute TTL and are cleared for the household. Restart discards both. |
| Pairing/provisioning | Pairing flows expire and are process-local. Provisioning grants expire after 10 minutes and are pruned during sync operations; finalization purges all remaining grants. |
| Chat content blobs (v1.1) | Encrypted message content by hash, stored until its message is edited, deleted by its author or removed by an admin; then its bytes are dropped (freed pages zeroed) and a tombstone (reference, size, uploader member and device, times; no bytes) keeps it from being uploaded again, up to 500,000 tombstones per household, oldest dropped first. A deletion that arrives before the upload is kept as a claim (up to 20,000 per member, that member's oldest dropped first). Blobs, tombstones and claims are purged at finalization. Backups keep the bytes as of backup time. Devices delete their copies when they next read the chat; a device that never syncs again keeps its copy. Separately, a device drops its cached copy of any blob it downloaded more than 90 days ago (nothing is deleted for good; opening the message fetches it again) ([SYNC](SYNC.md#chat-content-blobs-v11-110), [STORAGE](STORAGE.md#chat-content-blobs-v11-110)). |
| Chat in an export (v1.1) | An export may include the chat: its events and the content blobs this device still holds for messages that still exist. A message deleted for everyone is only a deleted placeholder in it, with no content. The file is yours: Kin cannot delete it afterwards, and it keeps the chat as of the export, including messages later deleted. A restore does not bring back content deleted for everyone after the export while the household syncs: the later deletion removes it on that device. The member's own "delete for me" list is in their export only ([PORTABILITY](PORTABILITY.md#household-chat-in-an-archive-v11-136)). |
| Family fridge (#317) | Encrypted board events in their own relay stream, up to 250,000 per household, kept while the household is active and purged with it at finalization. Erasing, taking a magnet down and clearing are later events that hide earlier ones; nothing is removed from the log, so a cleared drawing can be brought back and stays in backups and exports. Devices keep their own copy of the log until they leave the household, which deletes it ([SYNC](SYNC.md#board-relay-317), [ADR 0011](decisions/0011-family-fridge.md)). |
| Private storage (#489, [ADR 0019](decisions/0019-member-private-log.md)) | Each member's encrypted private events in a relay stream of their own, up to 50,000 per member, kept while the member is in the household. Removing a member purges their stream at once (in the removal's transaction); household deletion purges every member's stream at finalization. A household admin turning private storage off for children and teens deletes nothing: the service only stops relaying it. The member's own devices keep their private log, sealed under keys they hold, until it is removed locally ([SYNC](SYNC.md#private-relay-489)). Backups keep the ciphertext as of backup time. |
| Journal photos (#502) | Each member's sealed photo and thumbnail blobs, up to 2,000 and 256 MiB per member. A photo removed from an entry, or an entry deleted, is deleted on the service by the member's device once Undo has passed. Removing a member purges their blobs with their private stream; household deletion purges every member's. |
| Fridge in an export (#363) | Every export from a device holding the fridge includes all of its events, hidden ones included. The file is yours: Kin cannot delete it afterwards ([PORTABILITY](PORTABILITY.md#the-family-fridge-in-an-archive-363)). |
| Outside calendars synced by the service ([ADR 0022](decisions/0022-family-hub.md) §3, #667) | Each calendar's private link (plaintext), owner, audience, times and last fetch's status and ETag in `calendar_subscriptions`; never its events. A downloaded feed stays in the service's memory for at most 30 minutes. Removed when its owner or a household admin turns it off, at once with the owner on their removal (in the removal's transaction), and with the household at finalization. Each device keeps its sealed copy in `kin-calendar-feeds:<household>` until its next list of calendars no longer includes it. Backups keep rows (links included) as of backup time. |
| Problem reports and suggestions ([ADR 0021](decisions/0021-kin-for-everyone.md) §3) | What a person chose to send: typed text, the diagnostics they kept and an optional picture (at most 1 MiB), plaintext, in `feedback` and `feedback_screenshots`. Purged 180 days after arrival (an hourly job), at once with the member on their removal (in the removal's transaction), and with the household at finalization; freed pages are zeroed. The operator can purge sooner (`feedback-purge`). A copy forwarded to GitHub issues (never the picture or any ID) stays there until deleted on GitHub. An unsent report waits on the device in `kin-feedback-outbox` until sent or removed in What I've sent; Start over deletes it. Backups keep rows as of backup time. |
| Security audit | Global 10,000-row maximum; oldest rows are discarded when exceeded. Finalization purges the household's audit rows. This count bound is not a time-based promise. |
| Temporary/rate-limit state | Process-local, bounded and expired/reset; never an authority source after restart. |
| Backups | No automatic service-managed retention or expiry. Database backup files remain under operator control and may contain the database contents as of backup time. Restore requires an explicit acknowledgement and merges newer tombstones from an existing target. |
| Local stores, offline devices and user-created exports | Retained outside the server deletion mechanism until each holder removes them. Kin cannot discover, revoke or erase inaccessible copies. |

The tombstone is intentionally the only indefinitely retained household record.
It prevents this database from accepting an old household state after restore;
it is not a global registry shared by hosts. Its one-row-per-deleted-household
cardinality grows with deleted households. There is no safe garbage-collection
deadline that preserves anti-resurrection for arbitrarily old backups.

## Backup and restore guarantee

An in-place restore reads lifecycle rows from the pre-restore target before
replacement. If any target household is `deletion_pending`, restore is refused:
cancel deletion using current valid household authority or allow it to finalize
first. This prevents a backup from restoring stale membership, device or
credential authority that could authorize cancellation during the grace period.
For other targets, existing finalized `deleted` tombstones override stale
backups, including pending or active backup states; data for a deleted ID is
purged and cannot become authoritative. Active targets remain restorable.
The command refuses restore unless the operator supplies
`--acknowledge-deletion-history` and prints a warning.

If both the current database and its later tombstones have been lost, a backup
from before deletion cannot prove that deletion occurred. Kin cannot safely
reconcile a deletion it has no record of. The explicit restore warning is not a
claim of rollback protection. Backups copied elsewhere are not deleted when
the active database purges a household.

## Event history growth

The service keeps the full canonical encrypted relay history and bindings while
a household exists. There is no checkpointing, compaction or history pruning.
The existing per-household event/binding limits reject further writes; they do
not discard old history and are not a scale or retention guarantee. Final
deletion purges the service's complete event and cursor history. Existing
client copies remain. Any future compaction needs separate proof for replay,
unknown event preservation, offline writers, tombstones and backup restore.

## Local and user-controlled data

Service deletion cannot reach IndexedDB, keys, application caches, plaintext
already seen by an authorized adult, screenshots, exported archives, or
external backup providers. Users must remove local site data on each reachable
device and manage exports/backups where they are stored. Browser storage
deletion is not a guarantee of physical-media sanitization.
