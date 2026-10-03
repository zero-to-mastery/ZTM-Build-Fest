# Retention, Archival, and Deletion

**Status:** Current through v0.10.3. Domain Item, Handoff and Talk archival and encrypted user-created archives are implemented. Full household deletion, service/backup retention policy and event-log compaction remain unimplemented and are planned for v0.12. Event/projection rules are in [EVENTS](EVENTS.md) and [STATE](STATE.md); portability is in [PORTABILITY](PORTABILITY.md).

## Distinct operations

| Operation               | Meaning                                                                                                                                                    | What it does not mean                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Archive                 | Hide an item/record from normal active views using an explicit tombstone event such as `ITEM_ARCHIVED`; retain historical events for replay and summaries. | It is not household erasure or immediate physical deletion.                            |
| Household data deletion | A deliberate request to destroy the household's Kin data from controlled local and service storage, subject to honest backup/export limitations.           | It cannot revoke copies already exported, screenshotted, downloaded, or remembered.    |
| Device revocation       | Prevent a device from receiving future household data or submitting accepted events; may trigger key rotation.                                             | It cannot erase plaintext/keys already held by that device.                            |
| Member removal          | Explicitly end a member's authorization to the household and revoke their devices under a reviewed membership protocol.                                    | It is not the same as revoking one device and cannot retrieve previously learned data. |

Archive is routine domain state; deletion is a privacy/destructive operation. Never overload one UI control or event to imply both.

## Full household deletion responsibilities

Before offering household deletion in a synchronized product, specify and report the outcome for:

- **Local IndexedDB:** delete canonical event records, local context, derived caches, and app-owned temporary state on each reachable device.
- **Derived state/checkpoints:** discard projections and caches; they must not retain content after their source is erased.
- **Cryptographic keys:** revoke server access, remove keys from reachable authorized devices, and rotate keys for any household that remains active. Removing a key does not prove an offline device has no copy.
- **Trusted-device registry and credentials:** revoke device authorization and applicable sessions/credentials without conflating member removal with data erasure.
- **Sync ciphertext:** issue deletion to the relay and define retention windows, replicated stores, and service backups. The server must report what is pending or outside immediate control.
- **Metadata/logs:** define minimization and retention for routing IDs, IP/security logs, timestamps, and operational backups separately from event content.
- **User-created exports:** warn that copies saved elsewhere are outside Kin's control; Kin cannot revoke or remotely erase them.

The confirmation must describe scope, affected devices, sync state, and irreversibility in plain language. Do not claim global deletion until all controlled copies/backups have met the documented policy. Local-only v0.1.0 has no remote service or household deletion workflow; its local event log has a 10,000-event prototype limit, not a retention policy.

## Event log growth and optimization

The v0.1.0 contract caps the local log at 10,000 events and refuses additional writes rather than deleting history. This is a prototype bound, not a long-term scalability solution. Later releases should measure replay time and storage before introducing optimization.

Possible future strategies include:

- Derived projection caches that are disposable and rebuilt from events
- Verified snapshots/checkpoints to reduce replay cost
- Explicit archival or compaction only after preservation, restore, and multi-device deletion semantics exist

Core invariant:

> Optimization must not change observable household state.

## Snapshot/checkpoint concept

```text
canonical events 1–N
        |
        v
validated derived snapshot at N
        |
        v
canonical events N+1 onward
```

A snapshot is derived, never the authoritative history. It should identify the last included sequence/event, projection/schema version, and enough integrity metadata to detect accidental mismatch. A snapshot must be verifiable against its event prefix when created or restored; a digest is not authentication against a malicious actor. Full state must remain reconstructable from preserved source events until a separately approved and tested archival/compaction policy says otherwise.

Do not compact merely because the log is large. Safe compaction must account for offline devices that may later submit old events, exported backups, legal/user deletion expectations, migration rollback, and tombstone resurrection. The final compaction policy is deferred.

The planned v0.12 contract ([V0.12.0](V0.12.0.md)) must settle deletion
propagation, service-controlled primary/backup/log retention and whether verified
checkpoints or compaction can preserve state and offline-device semantics. Until
that work is implemented and verified, the event cap is only a prototype bound
and there is no promise of household-wide erasure.
