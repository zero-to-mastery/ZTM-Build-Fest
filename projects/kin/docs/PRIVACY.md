# Privacy

**Status:** v0.11.7 implementation candidate; awaiting human review. Local protected content is encrypted after verified migration. Sync is optional and uploads client-encrypted canonical event envelopes. The durable service receives no plaintext household event payloads or content keys, but it sees and persists routing and traffic metadata; no anonymity or zero-knowledge claim is made.

v0.10 encrypts local canonical events, duplicated outbox content, protected metadata
and private sync key material. Household drafts remain in unlocked memory only;
lock/reload discards them. Startup removes historical sessionStorage draft keys.
Locked startup does not load/replay household plaintext. The content-free
`household-locked` peer message and durable lock epoch invalidate peer capabilities.
Minimal routing IDs, format/lock state, ciphertext lengths and root wrappers remain
visible. Recovery secrets are user-held and never persisted or sent to the relay.

Same-origin tabs may exchange the fixed `events-changed` notification over `BroadcastChannel` after a committed write. The notification contains no household or event content; each tab reloads the event log from IndexedDB and reconstructs its own view locally.

Since You Last Looked stores only a local event cursor and local timestamp in the existing `local_context` singleton. A cursor means that this installation explicitly advanced through a boundary; it does not identify a person or assert that a named member read anything. Viewing or marking the summary does not write a household event. The additional `view-state-changed` BroadcastChannel message is a fixed, content-free marker; it carries no cursor, IDs, count, text, actor, or device.

Household information can be highly personal. Sync remains disabled until an authenticated adult explicitly enables it. Local-only use continues without sync.

## Intended principles

- **Local-first:** Begin with data stored and processed on the user's device where practical.
- **Minimum server knowledge:** If a service is introduced, design it to know as little household content as reasonably possible.
- **No advertising and no sale of data:** These are product commitments for the intended direction.
- **No household-content analytics:** Do not collect household content for analytics.
- **No default AI processing:** Household content will not be sent to an AI service by default. Kin is not designed around an AI runtime.
- **Encrypted synchronization:** v0.9 encrypts canonical event bytes before upload and verifies device signatures on recipients. A compromised authorized browser/runtime can still read content.
- **Explicit device authorization:** Pairing and local fingerprint comparison bind generated device keys before provisioning.
- **Device revocation:** Sessions are invalidated and future epochs rotate; prior plaintext/keys cannot be recalled.
- **Clear export and deletion controls:** These should be designed before meaningful household data is stored or synchronized.

## Local-first progression

The v0.1.0 release stores a local event history in browser storage and reconstructs state locally:

```text
Browser
   |
   v
IndexedDB
   |
   v
Rust reconstructs state
```

No remote sync exists in v0.1.0. Local-first describes where this release processes data; it is not a claim that browser storage alone is secure against device compromise, shared browser profiles, or malicious extensions.

## v0.9 Encrypted Sync Boundary

```text
Parent A
    |
  passkey
    |
 household key
    |
 encrypted events
    v
 sync service
    v
 encrypted events
    |
 household key
    |
  Parent B
```

The browser encrypts the exact canonical event bytes and signs envelopes with a device key. The service authorizes, stores, and forwards opaque envelopes; it does not reduce household semantics or hold plaintext epoch keys. Passkeys authenticate members and are not content keys. Full implementation details are in [V0.9.0](V0.9.0.md).

The service still sees household/member/device/session IDs, event IDs, per-device sequences, key epochs, cursors, ciphertext sizes, event counts/timing, provisioning participants, revocation timing, IP addresses, and connection patterns. It can infer which devices share a household and when they synchronize. Encryption does not make traffic anonymous.

The v0.11 implementation candidate stores identity, credential-verification
metadata, trusted-device authorization, opaque relay ciphertext, cursors,
provisioning coordination and bounded security audit entries in SQLite.
Successful relay acknowledgements follow a committed SQLite transaction;
recipient delivery/read, backup existence and hardware-level persistence are
not guaranteed. Sessions, WebAuthn ceremonies, unclaimed pairings and
rate-limit windows are process-local and reset on restart. Local event bytes
and cached exact envelopes remain on devices that hold them. Service backups
contain sensitive routing metadata and encrypted envelopes, and a stale restore
can roll back revocations or key epochs. New/replacement adults do not receive
pre-join epoch keys in v0.9; missing history may be unavailable. All
trusted-device/key loss can make content unrecoverable. See [V0.11.0](V0.11.0.md)
and the [Threat Model](THREAT-MODEL.md).

The planning design for these boundaries is documented in [Identity](IDENTITY.md), [Pairing](PAIRING.md), [Synchronization](SYNC.md), [Cryptography](CRYPTOGRAPHY.md), and the [Threat Model](THREAT-MODEL.md). These documents specify intended properties and open decisions; they do not establish implemented security guarantees.

## Data lifecycle questions

Event-oriented history is not an excuse to keep personal data indefinitely. The planning policy distinguishes routine archival, household deletion, device revocation, and member removal in [RETENTION](RETENTION.md), and specifies user-controlled portable copies in [PORTABILITY](PORTABILITY.md). Exact deletion propagation, durable-service backup windows, and relay metadata retention remain unresolved and are not implemented guarantees. v0.12 is planned to define lifecycle/deletion/retention; v0.13 is planned to define recovery and household continuity after loss. The [roadmap](ROADMAP.md) places these before v0.14 UX/UI consolidation.

## Claims boundary

Kin implements client-side encrypted event sync, but it has not received independent security review or production operational hardening. Do not call the service zero-knowledge, anonymous, or robustly recoverable; do not imply cryptography protects a compromised unlocked browser/runtime.

## v0.5.0 Pulse

Fixed Pulse value/expiry stay in local canonical events. No analytics, history UI, scores, interpretation, external service or content-bearing broadcasts. Expiry hides current detail without deleting source events. No actor ID/name is displayed. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

The summary derives household changes without monitoring people. It includes no read receipt, member-view tracking, actor attribution, contribution analytics, individual event timestamps, activity timeline, or summary history. It is processed locally, with no analytics, AI, or external service. See [V0.6.0](V0.6.0.md).
