# ADR 0019 — Private storage for each member: a member key and a private log

Status: **Implemented** (accepted in #481, epic #480). The decisions
recorded below are the ones written into epic #480 when the owner asked for
it. Every story is in: the member key and vault format 2 (#485), the private
log and stream (#489), and the member's own export (#493: KPEX 1, sealed
under the member key, openable with the backup code; PORTABILITY "A
member's private things").

## Context

Everything in Kin is household-shared: one household content key per epoch,
given to every member's devices. The journal (#496), the "Just for me" list
(#510), and reminders and settings that follow a member (#520) need a place
that **only one member's devices can read**, that syncs between those
devices, and that no other member, Adult or admin, can open.

[ADR 0018](0018-account-key-vault.md) gives each member an account vault,
encrypted on their device, that any of their devices can open with their
password, passkey or backup code. It already reserves a slot for a
private-storage key. Chat ([ADR 0008](0008-household-chat.md)) and the
fridge ([ADR 0011](0011-family-fridge.md)) show how a separate log works at
every layer.

## Decision

### A member key, kept in the vault

- Each member gets a **member key** (MK): a random 256-bit AES-GCM key,
  generated on their first device when they first use something private.
- MK lives **only in the member's vault** and on their unlocked devices. A
  device gets it by opening the vault, which it can already do (ADR 0018), so
  no new key-provisioning protocol is needed.
- **Private storage needs an account vault.** A member who set Kin up the old
  way (passkey and per-device backup key, no password) is invited to set up
  their account (ADR 0018 migration) the first time they open something
  private. Until then the private surfaces explain why and offer the step.
- **Epochs.** Revoking one of the member's devices starts a new MK epoch on a
  remaining device, which re-seals the vault. Vault format 2 replaces the
  single reserved slot with a list of member-key epochs; format 1 vaults are
  still read (V1.0-COMPATIBILITY addition). Old entries stay readable with old
  epochs, which stay in the vault. As with household epochs, a revoked device
  keeps whatever it already had.

### Its own log and stream: `private`

- **Rust:** a fourth log, `Log::Private`, beside household, chat and board,
  with its own cap (50,000 events per member), checkpoint and record kinds
  (from 100). Private kinds never enter household replay or KINS. A separate
  read export returns the member's private projection (journal entries,
  private items, reminders, settings) for the stories that add them.
- **Service:** a member-scoped relay stream (`/api/private/events`,
  `/api/private/status`) with the chat relay's rules (the device's own
  envelopes, gapless per-device sequence, idempotency, logical-time bound,
  rate window) and its own tables, quota and cursor. **The stream is keyed by
  member, not household:** the service accepts pushes and pulls only from that
  member's own trusted devices. Another member's device, an admin's device, a
  removed member and a revoked device are refused (tested).
- **Client:** a private log per member in IndexedDB, modelled on the chat log
  store, and a private pass in the sync coordinator after the board pass.
- **Encryption:** envelopes use AES-256-GCM under the current MK epoch, with
  AAD binding stream `private`, household, member, device, sequence and
  epoch, like household envelopes.

### Who gets private storage

| Member | Private storage |
|---|---|
| Adult | Yes. No other member, including household admins, can read it. |
| Limited (child or teen) | Yes by default. A household admin can turn private storage **off** for Limited members, with a passkey (or password re-entry, ADR 0018), like "Who can chat". Off means the service refuses the stream; what's already on the child's devices stays there, unread by anyone else. An admin can never read it. |
| Temporary | No. The service refuses the stream for Temporary members. |

### Lifecycle

- **Losing every device** no longer loses private data: the member signs in on
  a new device (password, passkey or backup code, ADR 0018), opens the vault,
  gets MK and pulls the private stream.
- **Member removed:** the service purges that member's private stream and
  vault. Copies on their own devices stay, as for household data.
- **Household deleted:** purged with everything else.
- **Exports:** household exports never include private logs. A member's own
  export may include their private log, sealed with MK (story #493, rescoped
  from a separate passphrase file to this, since the vault and backup code
  now cover device loss).
- **Search:** private records are searched only inside their own surfaces,
  on the member's devices; they never appear in household search.
- **Attachments** (journal photos) are encrypted under MK and stored as
  private-stream blobs, never household blobs.

### What the service learns

For each member: that they use private storage, the number, sizes and times
of private envelopes and blobs, and which of their devices sent them. Never
their content. PRIVACY and THREAT-MODEL gain these rows.

## Consequences

- Story #485 ("a key only my devices hold") becomes: MK generation, vault
  format 2 and MK rotation on device revocation. Its same-member provisioning
  task is replaced by the vault.
- Story #489 ("my private log syncs") builds the log, stream and pass.
- Story #493 is rescoped to "my private things in my own export".
- Journal, Just for me, reminders and settings build their records on this
  log.

## Alternatives considered

- **Same-member key packages without a vault** (extend pairing's
  recipient-bound packages with a member-key purpose). Works without accounts,
  but recovery after losing every device would need its own passphrase backup.
  The vault already solves that. Rejected in favour of requiring an account.
- **Private records inside the household log, encrypted to one member.**
  Every member's device would carry everyone's private ciphertext and its
  sizes and timing inside the shared history, and household replay would
  have to skip records it can't read. Rejected.
- **Deriving MK from the passkey's PRF.** Ties private data to one
  credential; passkeys never derive content keys (CRYPTOGRAPHY). Rejected.
